using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace TahaBLT
{
    // Phone touch mode (Chrome Remote Desktop style): the phone's fingers become real Windows touch contacts, so
    // Windows itself turns them into taps (click), pans (scroll), press-and-hold (right click) and drags, exactly
    // as on a touchscreen laptop. Without touch injection (Windows 7, or InitializeTouchInjection refused) the same
    // gestures are emulated with the mouse: tap = click, swipe = wheel scroll, hold = right click, hold+move = drag.
    public partial class Program
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct TouchPoint
        {
            public int x;
            public int y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TouchRect
        {
            public int left;
            public int top;
            public int right;
            public int bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct POINTER_INFO
        {
            public int pointerType;
            public uint pointerId;
            public uint frameId;
            public uint pointerFlags;
            public IntPtr sourceDevice;
            public IntPtr hwndTarget;
            public TouchPoint ptPixelLocation;
            public TouchPoint ptHimetricLocation;
            public TouchPoint ptPixelLocationRaw;
            public TouchPoint ptHimetricLocationRaw;
            public uint dwTime;
            public uint historyCount;
            public int inputData;
            public uint dwKeyStates;
            public ulong performanceCount;
            public int buttonChangeType;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct POINTER_TOUCH_INFO
        {
            public POINTER_INFO pointerInfo;
            public uint touchFlags;
            public uint touchMask;
            public TouchRect rcContact;
            public TouchRect rcContactRaw;
            public uint orientation;
            public uint pressure;
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool InitializeTouchInjection(uint maxCount, uint dwMode);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool InjectTouchInput(uint count, [In] POINTER_TOUCH_INFO[] contacts);

        private const int PT_TOUCH = 2;
        private const uint POINTER_FLAG_INRANGE = 0x2;
        private const uint POINTER_FLAG_INCONTACT = 0x4;
        private const uint POINTER_FLAG_DOWN = 0x10000;
        private const uint POINTER_FLAG_UPDATE = 0x20000;
        private const uint POINTER_FLAG_UP = 0x40000;
        private const uint POINTER_FLAG_CANCELED = 0x8000;
        private const uint TOUCH_MASK_CONTACTAREA = 0x1;
        private const uint TOUCH_MASK_ORIENTATION = 0x2;
        private const uint TOUCH_MASK_PRESSURE = 0x4;
        private const uint TOUCH_FEEDBACK_NONE = 0x3;
        private const int MaxTouchContacts = 5;

        private class TouchContact
        {
            public uint id;
            public int x;
            public int y;
            public bool isNew;
        }

        private static readonly object touchLock = new object();
        private static readonly Dictionary<uint, TouchContact> touchContacts = new Dictionary<uint, TouchContact>();
        private static int touchInjectionState; // 0 unknown, 1 available, -1 unavailable
        private static Timer touchKeepAliveTimer;
        private static long lastTouchFrameTick;
        private static long lastPhoneTouchTick;

        // Mouse emulation state (used only when touch injection is unavailable)
        private static bool emuActive;
        private static int emuStartX, emuStartY, emuLastX, emuLastY;
        private static long emuStartTick;
        private static bool emuScrolling, emuDragging;
        private static double emuScrollAcc;

        public static bool TouchInjectionAvailable
        {
            get
            {
                EnsureTouchInjection();
                return touchInjectionState == 1;
            }
        }

        private static void EnsureTouchInjection()
        {
            if (touchInjectionState != 0) return;
            lock (touchLock)
            {
                if (touchInjectionState != 0) return;
                bool ok = false;
                try { ok = InitializeTouchInjection(MaxTouchContacts, TOUCH_FEEDBACK_NONE); } catch { ok = false; }
                touchInjectionState = ok ? 1 : -1;
            }
        }

        // args: phase ("down" | "move" | "up" | "cancel"), id (finger), x/y (0..1 on monitorIndex)
        private static object HandleTouchInput(Dictionary<string, object> args, MonitorData mon)
        {
            string phase = args.ContainsKey("phase") ? Convert.ToString(args["phase"]) : "";
            uint id = args.ContainsKey("id") ? (uint)Math.Max(0, Math.Min(MaxTouchContacts - 1, Convert.ToInt32(args["id"]))) : 0u;
            double nx = args.ContainsKey("x") ? Math.Max(0.0, Math.Min(1.0, Convert.ToDouble(args["x"]))) : 0.5;
            double ny = args.ContainsKey("y") ? Math.Max(0.0, Math.Min(1.0, Convert.ToDouble(args["y"]))) : 0.5;
            int px = NormToScreen(mon.x, mon.width, nx);
            int py = NormToScreen(mon.y, mon.height, ny);

            lastPhoneTouchTick = Environment.TickCount;
            EnsureTouchInjection();
            if (touchInjectionState == 1)
            {
                bool injected = InjectTouchPhase(phase, id, px, py);
                if (injected) return new { ok = true, mode = "touch" };
                // Injection failed at runtime (e.g. secure desktop): fall through to the mouse for this gesture
            }
            EmulateTouchWithMouse(phase, id, px, py);
            return new { ok = true, mode = "mouse" };
        }

        private static bool InjectTouchPhase(string phase, uint id, int px, int py)
        {
            lock (touchLock)
            {
                TouchContact contact;
                bool exists = touchContacts.TryGetValue(id, out contact);
                if (phase == "down")
                {
                    if (exists)
                    {
                        // A lost "up" from the phone: finish the old contact before starting a new one
                        SendTouchFrame(id, POINTER_FLAG_UP);
                        touchContacts.Remove(id);
                    }
                    touchContacts[id] = new TouchContact { id = id, x = px, y = py, isNew = true };
                    bool ok = SendTouchFrame(uint.MaxValue, 0);
                    if (!ok) touchContacts.Remove(id);
                    EnsureTouchKeepAlive();
                    return ok;
                }
                if (!exists) return phase == "move"; // stray move after an up: ignore silently
                if (phase == "move")
                {
                    contact.x = px;
                    contact.y = py;
                    return SendTouchFrame(uint.MaxValue, 0);
                }
                contact.x = px;
                contact.y = py;
                bool sent = SendTouchFrame(id, phase == "cancel" ? (POINTER_FLAG_UP | POINTER_FLAG_CANCELED) : POINTER_FLAG_UP);
                touchContacts.Remove(id);
                return sent;
            }
        }

        // Every frame must describe all fingers currently on the screen. endingId gets endFlags; the rest are updates.
        private static bool SendTouchFrame(uint endingId, uint endFlags)
        {
            if (touchContacts.Count == 0) return true;
            var frame = new POINTER_TOUCH_INFO[touchContacts.Count];
            int i = 0;
            foreach (var c in touchContacts.Values)
            {
                uint flags;
                if (c.id == endingId) flags = endFlags;
                else if (c.isNew) flags = POINTER_FLAG_DOWN | POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT;
                else flags = POINTER_FLAG_UPDATE | POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT;
                c.isNew = false;

                var info = new POINTER_TOUCH_INFO();
                info.pointerInfo.pointerType = PT_TOUCH;
                info.pointerInfo.pointerId = c.id;
                info.pointerInfo.pointerFlags = flags;
                info.pointerInfo.ptPixelLocation.x = c.x;
                info.pointerInfo.ptPixelLocation.y = c.y;
                info.touchMask = TOUCH_MASK_CONTACTAREA | TOUCH_MASK_ORIENTATION | TOUCH_MASK_PRESSURE;
                info.orientation = 90;
                info.pressure = 32000;
                info.rcContact.left = c.x - 2;
                info.rcContact.right = c.x + 2;
                info.rcContact.top = c.y - 2;
                info.rcContact.bottom = c.y + 2;
                frame[i++] = info;
            }
            bool ok;
            try { ok = InjectTouchInput((uint)frame.Length, frame); } catch { ok = false; }
            lastTouchFrameTick = Environment.TickCount;
            return ok;
        }

        // Windows cancels a touch contact that receives no frames for a while, which would break press-and-hold
        // (right click) and slow drags. While a finger is down the last position is repeated every 60 ms.
        private static void EnsureTouchKeepAlive()
        {
            if (touchKeepAliveTimer != null) return;
            touchKeepAliveTimer = new Timer(_ =>
            {
                lock (touchLock)
                {
                    if (touchContacts.Count == 0) return;
                    // The phone vanished mid-gesture (network drop): never leave a finger pressed on the PC
                    if (unchecked(Environment.TickCount - lastPhoneTouchTick) > 8000)
                    {
                        foreach (var id in new List<uint>(touchContacts.Keys))
                        {
                            SendTouchFrame(id, POINTER_FLAG_UP | POINTER_FLAG_CANCELED);
                            touchContacts.Remove(id);
                        }
                        return;
                    }
                    if (unchecked(Environment.TickCount - lastTouchFrameTick) < 50) return;
                    SendTouchFrame(uint.MaxValue, 0);
                }
            }, null, 60, 60);
        }

        private static void EmulateTouchWithMouse(string phase, uint id, int px, int py)
        {
            if (id != 0) return; // the mouse has one pointer
            if (phase == "down")
            {
                emuActive = true;
                emuStartX = emuLastX = px;
                emuStartY = emuLastY = py;
                emuStartTick = Environment.TickCount;
                emuScrolling = emuDragging = false;
                emuScrollAcc = 0;
                SetCursorPos(px, py);
                mouse_event(MOUSEEVENTF_MOVE, 0, 0, 0, IntPtr.Zero);
                return;
            }
            if (!emuActive) return;
            long held = unchecked(Environment.TickCount - emuStartTick);
            int moved = Math.Abs(px - emuStartX) + Math.Abs(py - emuStartY);
            if (phase == "move")
            {
                if (!emuScrolling && !emuDragging && moved > 12)
                {
                    // Finger held still first = drag (like moving an icon); a quick swipe = scroll
                    if (held > 450)
                    {
                        emuDragging = true;
                        SetCursorPos(emuStartX, emuStartY);
                        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, IntPtr.Zero);
                    }
                    else emuScrolling = true;
                }
                if (emuDragging)
                {
                    SetCursorPos(px, py);
                    mouse_event(MOUSEEVENTF_MOVE, 0, 0, 0, IntPtr.Zero);
                }
                else if (emuScrolling)
                {
                    // Content follows the finger: moving the finger up scrolls the page down
                    emuScrollAcc += (py - emuLastY) * 3.0;
                    int step = (int)emuScrollAcc;
                    if (Math.Abs(step) >= 15)
                    {
                        emuScrollAcc -= step;
                        mouse_event(MOUSEEVENTF_WHEEL, 0, 0, (uint)step, IntPtr.Zero);
                    }
                }
                emuLastX = px;
                emuLastY = py;
                return;
            }
            // up / cancel
            emuActive = false;
            if (emuDragging)
            {
                SetCursorPos(px, py);
                mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
                return;
            }
            if (emuScrolling || phase == "cancel") return;
            if (held > 550) mouse_event(MOUSEEVENTF_RIGHTDOWN | MOUSEEVENTF_RIGHTUP, 0, 0, 0, IntPtr.Zero);
            else mouse_event(MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
        }
    }
}
