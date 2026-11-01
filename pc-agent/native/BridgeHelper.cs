using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace TahaBLT
{
    public partial class Program
    {
        #region Win32 P/Invoke Declarations

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdcMonitor, ref RECT lprcMonitor, IntPtr dwData);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct WINDOWPLACEMENT
        {
            public int length;
            public int flags;
            public int showCmd;
            public POINT ptMinPosition;
            public POINT ptMaxPosition;
            public RECT rcNormalPosition;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        public struct MONITORINFOEX
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
            public string szDevice;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        public struct DISPLAY_DEVICE
        {
            public int cb;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
            public string DeviceName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string DeviceString;
            public int StateFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string DeviceID;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
            public string DeviceKey;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct CURSORINFO
        {
            public int cbSize;
            public int flags;
            public IntPtr hCursor;
            public POINT ptScreenPos;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct ICONINFO
        {
            public bool fIcon;
            public int xHotspot;
            public int yHotspot;
            public IntPtr hbmMask;
            public IntPtr hbmColor;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT
        {
            public uint type;
            public InputUnion U;
        }

        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion
        {
            [FieldOffset(0)]
            public MOUSEINPUT mi;
            [FieldOffset(0)]
            public KEYBDINPUT ki;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder strText, int maxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowTextLength(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        public static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);

        [DllImport("user32.dll")]
        public static extern bool SetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        [DllImport("user32.dll")]
        public static extern bool BringWindowToTop(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll")]
        public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

        [DllImport("user32.dll")]
        public static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint crKey, byte bAlpha, uint dwFlags);

        [DllImport("shlwapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern uint AssocQueryString(int flags, int str, string pszAssoc, string pszExtra, StringBuilder pszOut, ref uint pcchOut);

        [DllImport("user32.dll")]
        public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX lpmi);

        [DllImport("user32.dll")]
        public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumProc lpfnEnum, IntPtr dwData);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool AddClipboardFormatListener(IntPtr hwnd);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool RemoveClipboardFormatListener(IntPtr hwnd);

        [DllImport("user32.dll")]
        public static extern bool OpenClipboard(IntPtr hWndNewOwner);

        [DllImport("user32.dll")]
        public static extern bool CloseClipboard();

        [DllImport("user32.dll")]
        public static extern IntPtr GetClipboardData(uint uFormat);

        [DllImport("user32.dll")]
        public static extern bool IsClipboardFormatAvailable(uint format);

        public const uint CF_UNICODETEXT = 13;

        public static string GetCurrentClipboardTextSafe()
        {
            for (int retry = 0; retry < 5; retry++)
            {
                if (OpenClipboard(IntPtr.Zero))
                {
                    try
                    {
                        if (IsClipboardFormatAvailable(CF_UNICODETEXT))
                        {
                            IntPtr handle = GetClipboardData(CF_UNICODETEXT);
                            if (handle != IntPtr.Zero)
                            {
                                string str = Marshal.PtrToStringUni(handle);
                                if (!string.IsNullOrEmpty(str))
                                {
                                    return str;
                                }
                            }
                        }
                    }
                    catch { }
                    finally
                    {
                        CloseClipboard();
                    }
                    break;
                }
                Thread.Sleep(20);
            }
            return null;
        }

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        public static extern bool EnumDisplayDevices(string lpDevice, uint iDevNum, ref DISPLAY_DEVICE lpDisplayDevice, uint dwFlags);

        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);

        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);

        [DllImport("user32.dll")]
        public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        public static extern IntPtr SendMessageTimeout(
            IntPtr hWnd,
            uint Msg,
            IntPtr wParam,
            IntPtr lParam,
            uint fuFlags,
            uint uTimeout,
            out IntPtr lpdwResult
        );

        [DllImport("user32.dll")]
        public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

        public delegate IntPtr LowLevelHookProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelHookProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        public static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("user32.dll")]
        public static extern bool ClipCursor(ref RECT lpRect);

        [DllImport("user32.dll")]
        public static extern bool ClipCursor(IntPtr lpRect);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern int SHEmptyRecycleBin(IntPtr hwnd, string pszRootPath, uint dwFlags);

        [DllImport("psapi.dll")]
        public static extern bool EmptyWorkingSet(IntPtr hwProc);

        [DllImport("user32.dll")]
        public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);

        [DllImport("user32.dll")]
        public static extern bool SetCursorPos(int X, int Y);

        [DllImport("user32.dll")]
        public static extern bool GetCursorInfo(out CURSORINFO pci);

        [DllImport("user32.dll")]
        public static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO piconinfo);

        [DllImport("user32.dll")]
        public static extern bool DrawIcon(IntPtr hDC, int X, int Y, IntPtr hIcon);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern uint PrivateExtractIconsW(
            string lpszFile,
            int nIconIndex,
            int cxIcon,
            int cyIcon,
            IntPtr[] phicon,
            uint[] piconid,
            uint nIcons,
            uint flags
        );

        [DllImport("user32.dll")]
        public static extern bool DestroyIcon(IntPtr hIcon);

        [ComImport]
        [Guid("00021401-0000-0000-C000-000000000046")]
        internal class ShellLinkComObject { }

        [ComImport]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        [Guid("000214F9-0000-0000-C000-000000000046")]
        internal interface IShellLinkW
        {
            void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cchMaxPath, IntPtr pfd, int fFlags);
            void GetIDList(out IntPtr ppidl);
            void SetIDList(IntPtr pidl);
            void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cchMaxName);
            void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
            void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cchMaxPath);
            void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
            void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cchMaxPath);
            void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
            void GetHotkey(out short pwHotkey);
            void SetHotkey(short wHotkey);
            void GetShowCmd(out int piShowCmd);
            void SetShowCmd(int iShowCmd);
            void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cchIconPath, out int piIcon);
            void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
            void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);
            void Resolve(IntPtr hwnd, int fFlags);
            void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
        }

        [DllImport("gdi32.dll")]
        public static extern bool DeleteObject(IntPtr hObject);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll")]
        public static extern bool LockWorkStation();

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetThreadDesktop(IntPtr hDesktop);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool CloseDesktop(IntPtr hDesktop);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int lpnLengthNeeded);

        [DllImport("kernel32.dll")]
        public static extern uint WTSGetActiveConsoleSessionId();

        [DllImport("wtsapi32.dll", SetLastError = true)]
        public static extern bool WTSQueryUserToken(uint sessionId, out IntPtr phToken);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        public static extern bool DuplicateTokenEx(
            IntPtr hExistingToken,
            uint dwDesiredAccess,
            IntPtr lpTokenAttributes,
            int ImpersonationLevel,
            int TokenType,
            out IntPtr phNewToken
        );

        [DllImport("userenv.dll", SetLastError = true)]
        public static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);

        [DllImport("userenv.dll", SetLastError = true)]
        public static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CreateProcessAsUserW(
            IntPtr hToken,
            string lpApplicationName,
            StringBuilder lpCommandLine,
            IntPtr lpProcessAttributes,
            IntPtr lpThreadAttributes,
            bool bInheritHandles,
            uint dwCreationFlags,
            IntPtr lpEnvironment,
            string lpCurrentDirectory,
            ref STARTUPINFO lpStartupInfo,
            out PROCESS_INFORMATION lpProcessInformation
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        public static bool SyncThreadToInputDesktop(out string desktopName)
        {
            desktopName = "";
            try
            {
                IntPtr hDesk = OpenInputDesktop(0, false, 0x01FF);
                if (hDesk != IntPtr.Zero)
                {
                    try
                    {
                        StringBuilder sb = new StringBuilder(128);
                        int needed;
                        if (GetUserObjectInformation(hDesk, 2, sb, sb.Capacity * 2, out needed))
                        {
                            desktopName = sb.ToString();
                        }
                    }
                    catch { }
                    bool ok = SetThreadDesktop(hDesk);
                    CloseDesktop(hDesk);
                    return ok;
                }
            }
            catch { }
            return false;
        }

        public static bool SyncThreadToInputDesktop()
        {
            string dummy;
            return SyncThreadToInputDesktop(out dummy);
        }

        public static bool IsRunningAsSystemAccount()
        {
            try
            {
                string u = Environment.UserName ?? "";
                return u.Equals("SYSTEM", StringComparison.OrdinalIgnoreCase) ||
                       u.Equals("LOCAL SERVICE", StringComparison.OrdinalIgnoreCase) ||
                       u.Equals("NETWORK SERVICE", StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
        }

        private static string cachedInteractiveProfileDir = null;
        private static long cachedInteractiveProfileTick = 0;

        public static string GetInteractiveUserProfilePath()
        {
            if (!IsRunningAsSystemAccount())
            {
                return Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            }

            long now = Environment.TickCount;
            if (!string.IsNullOrEmpty(cachedInteractiveProfileDir) && Math.Abs(now - cachedInteractiveProfileTick) < 10000 && Directory.Exists(cachedInteractiveProfileDir))
            {
                return cachedInteractiveProfileDir;
            }

            try
            {
                using (var profileList = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList"))
                {
                    if (profileList != null)
                    {
                        string bestProfile = null;
                        DateTime bestTime = DateTime.MinValue;
                        foreach (var sid in profileList.GetSubKeyNames())
                        {
                            if (!sid.StartsWith("S-1-5-21-", StringComparison.OrdinalIgnoreCase)) continue;
                            using (var sk = profileList.OpenSubKey(sid))
                            {
                                if (sk == null) continue;
                                string path = Environment.ExpandEnvironmentVariables(Convert.ToString(sk.GetValue("ProfileImagePath") ?? "").Trim());
                                if (!string.IsNullOrEmpty(path) && Directory.Exists(path))
                                {
                                    DateTime wt = Directory.GetLastWriteTimeUtc(path);
                                    if (wt > bestTime)
                                    {
                                        bestTime = wt;
                                        bestProfile = path;
                                    }
                                }
                            }
                        }
                        if (!string.IsNullOrEmpty(bestProfile))
                        {
                            cachedInteractiveProfileDir = bestProfile;
                            cachedInteractiveProfileTick = now;
                            return bestProfile;
                        }
                    }
                }
            }
            catch { }

            try
            {
                foreach (var d in Directory.GetDirectories(@"C:\Users"))
                {
                    string name = Path.GetFileName(d);
                    if (name.Equals("Public", StringComparison.OrdinalIgnoreCase) ||
                        name.Equals("Default", StringComparison.OrdinalIgnoreCase) ||
                        name.Equals("Default User", StringComparison.OrdinalIgnoreCase) ||
                        name.Equals("All Users", StringComparison.OrdinalIgnoreCase))
                        continue;
                    if (Directory.Exists(Path.Combine(d, "Desktop")))
                    {
                        cachedInteractiveProfileDir = d;
                        cachedInteractiveProfileTick = now;
                        return d;
                    }
                }
            }
            catch { }

            return Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        }

        public static RegistryKey OpenInteractiveUserRegistryRoot()
        {
            if (!IsRunningAsSystemAccount())
            {
                return Registry.CurrentUser;
            }
            try
            {
                string profilePath = GetInteractiveUserProfilePath();
                using (var profileList = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList"))
                {
                    if (profileList != null)
                    {
                        foreach (var sid in profileList.GetSubKeyNames())
                        {
                            if (!sid.StartsWith("S-1-5-21-", StringComparison.OrdinalIgnoreCase)) continue;
                            using (var sk = profileList.OpenSubKey(sid))
                            {
                                if (sk == null) continue;
                                string p = Environment.ExpandEnvironmentVariables(Convert.ToString(sk.GetValue("ProfileImagePath") ?? "").Trim());
                                if (string.Equals(p, profilePath, StringComparison.OrdinalIgnoreCase))
                                {
                                    var uKey = Registry.Users.OpenSubKey(sid);
                                    if (uKey != null) return uKey;
                                }
                            }
                        }
                    }
                }
            }
            catch { }
            return Registry.CurrentUser;
        }

        public static bool TryStartProcessInActiveUserSession(string fileName, string arguments, string workingDir, string windowStyle, out int startedPid)
        {
            startedPid = 0;
            if (!IsRunningAsSystemAccount()) return false;

            IntPtr hUserToken = IntPtr.Zero;
            IntPtr hPrimaryToken = IntPtr.Zero;
            IntPtr pEnv = IntPtr.Zero;
            try
            {
                uint sessionId = WTSGetActiveConsoleSessionId();
                if (sessionId == 0xFFFFFFFF) return false;
                if (!WTSQueryUserToken(sessionId, out hUserToken) || hUserToken == IntPtr.Zero) return false;

                if (!DuplicateTokenEx(hUserToken, 0xF01FF, IntPtr.Zero, 2, 1, out hPrimaryToken) || hPrimaryToken == IntPtr.Zero)
                    return false;

                CreateEnvironmentBlock(out pEnv, hPrimaryToken, false);

                STARTUPINFO si = new STARTUPINFO();
                si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                si.lpDesktop = @"winsta0\default";
                si.dwFlags = 0x00000001; // STARTF_USESHOWWINDOW
                if (windowStyle == "maximized") si.wShowWindow = 3;
                else if (windowStyle == "minimized") si.wShowWindow = 7;
                else if (windowStyle == "hidden") si.wShowWindow = 0;
                else si.wShowWindow = 1;

                string cmdExe = fileName;
                string cmdArgs = arguments ?? "";
                if (!File.Exists(cmdExe) || (!cmdExe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && !cmdExe.EndsWith(".bat", StringComparison.OrdinalIgnoreCase) && !cmdExe.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase)))
                {
                    cmdArgs = string.IsNullOrEmpty(cmdArgs) ? ("\"" + cmdExe + "\"") : ("\"" + cmdExe + "\" " + cmdArgs);
                    cmdExe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe");
                }
                else if (cmdExe.Equals("explorer.exe", StringComparison.OrdinalIgnoreCase))
                {
                    cmdExe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe");
                }

                StringBuilder cmdLine = new StringBuilder();
                cmdLine.Append("\"").Append(cmdExe).Append("\"");
                if (!string.IsNullOrEmpty(cmdArgs))
                {
                    cmdLine.Append(" ").Append(cmdArgs);
                }

                uint flags = 0x00000400 | 0x00000010; // CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_CONSOLE
                string dir = (!string.IsNullOrEmpty(workingDir) && Directory.Exists(workingDir)) ? workingDir : GetInteractiveUserProfilePath();

                PROCESS_INFORMATION pi;
                if (CreateProcessAsUserW(hPrimaryToken, null, cmdLine, IntPtr.Zero, IntPtr.Zero, false, flags, pEnv, dir, ref si, out pi))
                {
                    startedPid = pi.dwProcessId;
                    if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
                    if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
                    return true;
                }
            }
            catch { }
            finally
            {
                if (pEnv != IntPtr.Zero) DestroyEnvironmentBlock(pEnv);
                if (hPrimaryToken != IntPtr.Zero) CloseHandle(hPrimaryToken);
                if (hUserToken != IntPtr.Zero) CloseHandle(hUserToken);
            }
            return false;
        }

        [DllImport("powrprof.dll", SetLastError = true)]
        public static extern bool SetSuspendState(bool hibernate, bool forceCritical, bool disableWakeEvent);

        [DllImport("kernel32.dll")]
        public static extern uint SetThreadExecutionState(uint esFlags);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        public class MEMORYSTATUSEX
        {
            public uint dwLength;
            public uint dwMemoryLoad;
            public ulong ullTotalPhys;
            public ulong ullAvailPhys;
            public ulong ullTotalPageFile;
            public ulong ullAvailPageFile;
            public ulong ullTotalVirtual;
            public ulong ullAvailVirtual;
            public ulong ullAvailExtendedVirtual;
            public MEMORYSTATUSEX()
            {
                this.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
            }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool GlobalMemoryStatusEx([In, Out] MEMORYSTATUSEX lpBuffer);

        public const int GWL_STYLE = -16;
        public const int GWL_EXSTYLE = -20;
        public const uint WS_VISIBLE = 0x10000000;
        public const uint WS_EX_TOPMOST = 0x00000008;
        public const uint WS_EX_TOOLWINDOW = 0x00000080;
        public const uint WS_EX_APPWINDOW = 0x00040000;
        public const int WS_EX_LAYERED = 0x00080000;
        public const uint LWA_ALPHA = 0x00000002;

        public const int SW_HIDE = 0;
        public const int SW_SHOWNORMAL = 1;
        public const int SW_SHOWMINIMIZED = 2;
        public const int SW_SHOWMAXIMIZED = 3;
        public const int SW_MAXIMIZE = 3;
        public const int SW_SHOWNOACTIVATE = 4;
        public const int SW_SHOW = 5;
        public const int SW_MINIMIZE = 6;
        public const int SW_SHOWMINNOACTIVE = 7;
        public const int SW_RESTORE = 9;

        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOMOVE = 0x0002;
        public const uint SWP_NOZORDER = 0x0004;
        public const uint SWP_NOACTIVATE = 0x0010;
        public const uint SWP_FRAMECHANGED = 0x0020;
        public const uint SWP_SHOWWINDOW = 0x0040;

        public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;
        public const int DWMWA_CLOAKED = 14;

        public const uint WM_SYSCOMMAND = 0x0112;
        public const uint WM_CLOSE = 0x0010;
        public const int SC_MONITORPOWER = 0xF170;
        public static readonly IntPtr HWND_BROADCAST = new IntPtr(0xffff);
        public static readonly IntPtr HWND_TOP = IntPtr.Zero;
        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

        public const uint INPUT_MOUSE = 0;
        public const uint INPUT_KEYBOARD = 1;
        public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        public const uint KEYEVENTF_KEYUP = 0x0002;
        public const uint KEYEVENTF_UNICODE = 0x0004;

        public const uint MOUSEEVENTF_MOVE = 0x0001;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        public const uint MOUSEEVENTF_WHEEL = 0x0800;
        public const uint MOUSEEVENTF_HWHEEL = 0x01000;

        #endregion

        #region CoreAudio COM Declarations (Master & Per-App Volume Mixer)

        [ComImport]
        [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
        internal class MMDeviceEnumeratorComObject { }

        internal enum EDataFlow { eRender, eCapture, eAll }
        internal enum ERole { eConsole, eMultimedia, eCommunications }

        [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface IMMDeviceEnumerator
        {
            int EnumAudioEndpoints(EDataFlow dataFlow, int dwStateMask, out IMMDeviceCollection ppDevices);
            int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppEndpoint);
        }

        [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface IMMDeviceCollection
        {
            int GetCount(out uint pcDevices);
            int Item(uint nDevice, out IMMDevice ppDevice);
        }

        [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface IMMDevice
        {
            int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
            int OpenPropertyStore(int stgmAccess, out IPropertyStore ppProperties);
            int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
            int GetState(out int pdwState);
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct PROPERTYKEY
        {
            public Guid fmtid;
            public uint pid;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct PROPVARIANT
        {
            public ushort vt;
            public ushort wReserved1;
            public ushort wReserved2;
            public ushort wReserved3;
            public IntPtr p;
            public int p2;
        }

        [DllImport("ole32.dll")]
        internal static extern int PropVariantClear(ref PROPVARIANT pvar);

        [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface IPropertyStore
        {
            int GetCount(out uint cProps);
            int GetAt(uint iProp, out PROPERTYKEY pkey);
            int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
            int SetValue(ref PROPERTYKEY key, ref PROPVARIANT propvar);
            int Commit();
        }

        [ComImport]
        [Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
        internal class PolicyConfigClientComObject { }

        [Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface IPolicyConfig
        {
            int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, out IntPtr ppFormat);
            int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, int bDefault, out IntPtr ppFormat);
            int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName);
            int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, IntPtr pEndpointFormat, IntPtr mixFormat);
            int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, int bDefault, out long pmftDefaultPeriod, out long pmftMinimumPeriod);
            int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, ref long pmftPeriod);
            int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, out IntPtr pMode);
            int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, IntPtr mode);
            int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, int bFxStore, ref PROPERTYKEY key, out PROPVARIANT pv);
            int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, int bFxStore, ref PROPERTYKEY key, ref PROPVARIANT pv);
            int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, ERole role);
            int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, int bVisible);
        }

        [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface IAudioEndpointVolume
        {
            int RegisterControlChangeNotify(IntPtr pNotify);
            int UnregisterControlChangeNotify(IntPtr pNotify);
            int GetChannelCount(out int pnChannelCount);
            int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
            int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
            int GetMasterVolumeLevel(out float pfLevelDB);
            int GetMasterVolumeLevelScalar(out float pfLevel);
            int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
            int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
            int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
            int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
            int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
            int GetMute(out bool pbMute);
        }

        [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface IAudioSessionManager2
        {
            int GetAudioSessionControl(IntPtr AudioSessionGuid, uint StreamFlags, out IntPtr SessionControl);
            int GetSimpleAudioVolume(IntPtr AudioSessionGuid, uint StreamFlags, out ISimpleAudioVolume AudioVolume);
            int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
        }

        [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface IAudioSessionEnumerator
        {
            int GetCount(out int SessionCount);
            int GetSession(int SessionCount, out IAudioSessionControl2 Session);
        }

        [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface IAudioSessionControl2
        {
            int GetState(out int pRetVal);
            int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
            int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
            int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
            int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
            int GetGroupingParam(out Guid pRetVal);
            int SetGroupingParam(ref Guid Override, ref Guid EventContext);
            int RegisterAudioSessionNotification(IntPtr NewNotifications);
            int UnregisterAudioSessionNotification(IntPtr NewNotifications);
            int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
            int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
            int GetProcessId(out uint pRetVal);
            int IsSystemSoundsSession();
            int SetDuckingPreference(bool optOut);
        }

        [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface ISimpleAudioVolume
        {
            int SetMasterVolume(float fLevel, ref Guid EventContext);
            int GetMasterVolume(out float pfLevel);
            int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid EventContext);
            int GetMute(out bool pbMute);
        }

        [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        internal interface IAudioMeterInformation
        {
            int GetPeakValue(out float pfPeak);
        }

        #endregion

        private static JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = 50 * 1024 * 1024 };
        private static Form uiDispatcherForm;
        private static Dictionary<int, Form> blackoutForms = new Dictionary<int, Form>();
        private static Dictionary<int, Form> dimmerForms = new Dictionary<int, Form>();
        private static Dictionary<int, int> monitorBrightnessMap = new Dictionary<int, int>();
        private static PerformanceCounter cpuCounter;

        public class ClickThroughDimmerForm : Form
        {
            protected override bool ShowWithoutActivation { get { return true; } }
            protected override CreateParams CreateParams
            {
                get
                {
                    CreateParams cp = base.CreateParams;
                    // WS_EX_LAYERED (0x80000) | WS_EX_TRANSPARENT (0x20) | WS_EX_TOOLWINDOW (0x80) | WS_EX_TOPMOST (0x08) | WS_EX_NOACTIVATE (0x08000000)
                    cp.ExStyle |= 0x00080000 | 0x00000020 | 0x00000080 | 0x00000008 | 0x08000000;
                    return cp;
                }
            }
        }

        public class ClipboardListenerForm : Form
        {
            private const int WM_CLIPBOARDUPDATE = 0x031D;

            protected override void OnHandleCreated(EventArgs e)
            {
                base.OnHandleCreated(e);
                try { AddClipboardFormatListener(this.Handle); } catch { }
            }

            protected override void OnHandleDestroyed(EventArgs e)
            {
                try { RemoveClipboardFormatListener(this.Handle); } catch { }
                base.OnHandleDestroyed(e);
            }

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == WM_CLIPBOARDUPDATE)
                {
                    PollClipboardHistoryOnSta();
                }
                base.WndProc(ref m);
            }
        }

        public class MonitorData
        {
            public int index;
            public string id;
            public string deviceName;
            public string friendlyName;
            public bool isPrimary;
            public int x;
            public int y;
            public int width;
            public int height;
            public int workX;
            public int workY;
            public int workWidth;
            public int workHeight;
            public bool isBlackedOut;
            public int brightness;
        }

        [STAThread]
        public static void Main(string[] args)
        {
            try { SetProcessDPIAware(); } catch { }
            if (args.Length > 0 && args[0] == "--video-selftest")
            {
                // --video-selftest [h264|av1] [dump-file]
                RunVideoSelfTest(args.Length > 1 && args[1] == "av1", args.Length > 2 ? args[2] : null);
                return;
            }
            try { Console.InputEncoding = Encoding.UTF8; } catch { }
            try { Console.OutputEncoding = Encoding.UTF8; } catch { }
            try
            {
                Stream stdinStream = Console.OpenStandardInput();
                if (stdinStream != null && stdinStream != Stream.Null)
                {
                    Console.SetIn(new StreamReader(stdinStream, new UTF8Encoding(false)));
                }
            }
            catch { }
            try
            {
                Stream stdoutStream = Console.OpenStandardOutput();
                if (stdoutStream != null && stdoutStream != Stream.Null)
                {
                    StreamWriter sw = new StreamWriter(stdoutStream, new UTF8Encoding(false)) { AutoFlush = true };
                    Console.SetOut(sw);
                }
            }
            catch { }

            try
            {
                cpuCounter = new PerformanceCounter("Processor", "% Processor Time", "_Total");
                cpuCounter.NextValue();
            }
            catch { }

            try { LoadPersistedClipboardHistory(); } catch { }
            try { SyncWinRtClipboardHistory(true); } catch { }

            // Start dedicated UI thread for monitor Blackout overlays, Lock hooks & Clipboard history
            Thread uiThread = new Thread(() =>
            {
                Application.EnableVisualStyles();
                uiDispatcherForm = new ClipboardListenerForm
                {
                    ShowInTaskbar = false,
                    FormBorderStyle = FormBorderStyle.None,
                    Opacity = 0,
                    Width = 1,
                    Height = 1
                };
                IntPtr handle = uiDispatcherForm.Handle; // Force handle creation
                try { ClipCursor(IntPtr.Zero); } catch { }
                        try { Cursor.Show(); } catch { }

                System.Windows.Forms.Timer clipTimer = new System.Windows.Forms.Timer { Interval = 850 };
                clipTimer.Tick += (s, e) => PollClipboardHistoryOnSta();
                clipTimer.Start();
                PollClipboardHistoryOnSta();

                System.Windows.Forms.Timer lockWatchTimer = new System.Windows.Forms.Timer { Interval = 90 };
                lockWatchTimer.Tick += (s, e) => EnforceLockShieldWatchdogOnSta();
                lockWatchTimer.Start();

                Application.Run();
            });
            uiThread.SetApartmentState(ApartmentState.STA);
            uiThread.IsBackground = true;
            uiThread.Start();

            // Wait until uiDispatcherForm handle is ready
            int waitTicks = 0;
            while ((uiDispatcherForm == null || !uiDispatcherForm.IsHandleCreated) && waitTicks < 100)
            {
                Thread.Sleep(10);
                waitTicks++;
            }

            StartBinaryStreamServer();
            StartFastInputServer();

            // Pre-warm MSIX/Store catalog in background so first app query is instant
            ThreadPool.QueueUserWorkItem(_ => { try { EnsureMsixCatalogLoaded(); } catch { } });

            // Keep CPU & Network Adapter awake at all times (ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED)
            // so turning off monitors via SC_MONITORPOWER never causes Windows Modern Standby or NIC sleep after 5 minutes.
            Thread powerKeepAliveThread = new Thread(() =>
            {
                while (true)
                {
                    try
                    {
                        SetThreadExecutionState(0x80000000 | 0x00000001 | 0x00000040);
                    }
                    catch { }
                    Thread.Sleep(15000);
                }
            });
            powerKeepAliveThread.IsBackground = true;
            powerKeepAliveThread.Start();

            // Read newline-delimited JSON commands from stdin
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                try
                {
                    var req = serializer.Deserialize<Dictionary<string, object>>(line);
                    object id = req.ContainsKey("id") ? req["id"] : 0;
                    string cmd = req.ContainsKey("cmd") ? Convert.ToString(req["cmd"]) : "";
                    Dictionary<string, object> cmdArgs = req.ContainsKey("args") && req["args"] is Dictionary<string, object>
                        ? (Dictionary<string, object>)req["args"]
                        : new Dictionary<string, object>();

                    // Execute ultra-fast input & display wake commands immediately on the reader thread
                    if (cmd == "send_input" || cmd == "ping" || cmd == "monitor_power")
                    {
                        object result = HandleCommand(cmd, cmdArgs);
                        if (id != null && Convert.ToString(id) != "0")
                        {
                            WriteResponse(new Dictionary<string, object>
                            {
                                { "id", id },
                                { "ok", true },
                                { "data", result }
                            });
                        }
                    }
                    else
                    {
                        ThreadPool.QueueUserWorkItem(_ =>
                        {
                            try
                            {
                                object result = HandleCommand(cmd, cmdArgs);
                                WriteResponse(new Dictionary<string, object>
                                {
                                    { "id", id },
                                    { "ok", true },
                                    { "data", result }
                                });
                            }
                            catch (Exception innerEx)
                            {
                                WriteResponse(new Dictionary<string, object>
                                {
                                    { "id", id },
                                    { "ok", false },
                                    { "error", innerEx.Message }
                                });
                            }
                        });
                    }
                }
                catch (Exception ex)
                {
                    WriteResponse(new Dictionary<string, object>
                    {
                        { "id", 0 },
                        { "ok", false },
                        { "error", ex.Message }
                    });
                }
            }
        }

        private static object writeLock = new object();
        private static void WriteResponse(Dictionary<string, object> resp)
        {
            string json = serializer.Serialize(resp);
            lock (writeLock)
            {
                Console.WriteLine(json);
                Console.Out.Flush();
            }
        }

        private static object HandleCommand(string cmd, Dictionary<string, object> args)
        {
            switch (cmd)
            {
                case "ping":
                    return new { pong = true, timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
                case "get_monitors":
                    return GetMonitorsList();
                case "monitor_power":
                    return HandleMonitorPower(args);
                case "monitor_blackout":
                    return HandleMonitorBlackout(args);
                case "display_topology":
                    return HandleDisplayTopology(args);
                case "get_windows":
                    return GetOpenWindows();
                case "get_installed_apps":
                    return GetInstalledApps();
                case "snap_window":
                    return SnapWindowCommand(args);
                case "focus_window":
                    return FocusWindowCommand(args);
                case "close_window":
                    return CloseWindowCommand(args);
                case "window_action":
                    return WindowActionCommand(args);
                case "browse_fs":
                    return BrowseFileSystemCommand(args);
                case "inspect_target":
                    return InspectTargetCommand(args);
                case "get_file_icon":
                    string iconReqPath = args.ContainsKey("path") ? Convert.ToString(args["path"]).Trim() : "";
                    return new { icon = GetAppIconBase64(iconReqPath) };
                case "execute_quick_item":
                    return ExecuteQuickItemCommand(args);
                case "capture_screen":
                    return CaptureScreenCommand(args);
                case "send_input":
                    return SendInputCommand(args);
                case "audio_control":
                    return HandleAudioControl(args);
                case "system_control":
                    return HandleSystemControl(args);
                case "wireless_control":
                    return HandleWirelessControl(args);
                default:
                    throw new Exception("Unknown command: " + cmd);
            }
        }

        #region Monitor Management

        public static List<MonitorData> GetMonitorsList()
        {
            var list = new List<MonitorData>();
            var screens = Screen.AllScreens;
            // Sort screens so Primary is index 0, then ordered by Left coordinate
            Array.Sort(screens, (a, b) =>
            {
                if (a.Primary != b.Primary) return a.Primary ? -1 : 1;
                if (a.Bounds.X != b.Bounds.X) return a.Bounds.X.CompareTo(b.Bounds.X);
                return a.Bounds.Y.CompareTo(b.Bounds.Y);
            });

            for (int i = 0; i < screens.Length; i++)
            {
                var s = screens[i];
                string friendly = "Ekran " + (i + 1);
                try
                {
                    DISPLAY_DEVICE dd = new DISPLAY_DEVICE();
                    dd.cb = Marshal.SizeOf(dd);
                    if (EnumDisplayDevices(s.DeviceName, 0, ref dd, 0))
                    {
                        if (!string.IsNullOrWhiteSpace(dd.DeviceString))
                            friendly = dd.DeviceString.Trim();
                    }
                }
                catch { }

                bool blacked = false;
                lock (blackoutForms)
                {
                    if (blackoutForms.ContainsKey(i) && blackoutForms[i] != null && !blackoutForms[i].IsDisposed && blackoutForms[i].Visible)
                        blacked = true;
                }

                int monBrightness = 100;
                lock (monitorBrightnessMap)
                {
                    if (monitorBrightnessMap.ContainsKey(i))
                        monBrightness = monitorBrightnessMap[i];
                    else
                        monBrightness = currentBrightnessLevel;
                }

                list.Add(new MonitorData
                {
                    index = i,
                    id = "MON_" + (i + 1),
                    deviceName = s.DeviceName,
                    friendlyName = friendly,
                    isPrimary = s.Primary,
                    x = s.Bounds.X,
                    y = s.Bounds.Y,
                    width = s.Bounds.Width,
                    height = s.Bounds.Height,
                    workX = s.WorkingArea.X,
                    workY = s.WorkingArea.Y,
                    workWidth = s.WorkingArea.Width,
                    workHeight = s.WorkingArea.Height,
                    isBlackedOut = blacked,
                    brightness = monBrightness
                });
            }
            return list;
        }

        private static bool monitorsManuallyOff = false;

        private static void ReassertMonitorsOffIfNeeded()
        {
            if (!monitorsManuallyOff) return;
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    Thread.Sleep(110);
                    if (monitorsManuallyOff)
                    {
                        PostMessage(HWND_BROADCAST, WM_SYSCOMMAND, new IntPtr(SC_MONITORPOWER), new IntPtr(2));
                    }
                    Thread.Sleep(320);
                    if (monitorsManuallyOff)
                    {
                        PostMessage(HWND_BROADCAST, WM_SYSCOMMAND, new IntPtr(SC_MONITORPOWER), new IntPtr(2));
                    }
                }
                catch { }
            });
        }

        private static object HandleMonitorPower(Dictionary<string, object> args)
        {
            string action = args.ContainsKey("action") ? Convert.ToString(args["action"]) : "off";
            if (action == "off")
            {
                monitorsManuallyOff = true;
                // Ensure system and network stay awake in Away Mode while displays are powered down
                try { SetThreadExecutionState(0x80000000 | 0x00000001 | 0x00000040); } catch { }
                ThreadPool.QueueUserWorkItem(_ =>
                {
                    try { SetThreadExecutionState(0x80000000 | 0x00000001 | 0x00000040); } catch { }
                    Thread.Sleep(80);
                    if (monitorsManuallyOff)
                    {
                        PostMessage(HWND_BROADCAST, WM_SYSCOMMAND, new IntPtr(SC_MONITORPOWER), new IntPtr(2));
                    }
                });
                return new { status = "monitors_sleeping" };
            }
            else
            {
                monitorsManuallyOff = false;
                // Wake up monitors from deep DPMS standby immediately without blocking
                Action wakePulse = () =>
                {
                    try { SetThreadExecutionState(0x80000000 | 0x00000002 | 0x00000001 | 0x00000040); } catch { }
                    try { SetThreadExecutionState(0x00000002 | 0x00000001); } catch { }
                    try { PostMessage(HWND_BROADCAST, WM_SYSCOMMAND, new IntPtr(SC_MONITORPOWER), new IntPtr(-1)); } catch { }
                    try
                    {
                        IntPtr msgRes;
                        SendMessageTimeout(HWND_BROADCAST, WM_SYSCOMMAND, new IntPtr(SC_MONITORPOWER), new IntPtr(-1), 0x0002, 120, out msgRes);
                    }
                    catch { }

                    try
                    {
                        INPUT[] inputs = new INPUT[2];
                        inputs[0].type = INPUT_MOUSE;
                        inputs[0].U.mi.dx = 2;
                        inputs[0].U.mi.dy = 2;
                        inputs[0].U.mi.dwFlags = MOUSEEVENTF_MOVE;
                        inputs[1].type = INPUT_MOUSE;
                        inputs[1].U.mi.dx = -2;
                        inputs[1].U.mi.dy = -2;
                        inputs[1].U.mi.dwFlags = MOUSEEVENTF_MOVE;
                        SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
                    }
                    catch { }

                    try
                    {
                        mouse_event(MOUSEEVENTF_MOVE, 2, 1, 0, IntPtr.Zero);
                        mouse_event(MOUSEEVENTF_MOVE, -2, -1, 0, IntPtr.Zero);
                    }
                    catch { }
                };

                wakePulse();
                if (uiDispatcherForm != null && uiDispatcherForm.IsHandleCreated)
                {
                    try { uiDispatcherForm.BeginInvoke((MethodInvoker)delegate { wakePulse(); }); } catch { }
                }
                ThreadPool.QueueUserWorkItem(_ =>
                {
                    Thread.Sleep(110);
                    wakePulse();
                    Thread.Sleep(220);
                    wakePulse();
                });

                if (!args.ContainsKey("clearBlackouts") || Convert.ToBoolean(args["clearBlackouts"]))
                {
                    ClearAllBlackouts();
                }
                return new { status = "monitors_awake" };
            }
        }

        private static void ClearAllBlackouts()
        {
            if (uiDispatcherForm != null && uiDispatcherForm.IsHandleCreated)
            {
                try
                {
                    // Synchronous: the reply (and the monitor list sent to phones) must already show the curtains gone
                    uiDispatcherForm.Invoke((MethodInvoker)delegate
                    {
                        lock (blackoutForms)
                        {
                            foreach (var kv in blackoutForms)
                            {
                                if (kv.Value != null && !kv.Value.IsDisposed)
                                {
                                    kv.Value.Hide();
                                    kv.Value.Close();
                                }
                            }
                            blackoutForms.Clear();
                        }
                    });
                }
                catch { }
            }
        }

        private static object HandleMonitorBlackout(Dictionary<string, object> args)
        {
            if (args.ContainsKey("clearAll") && Convert.ToBoolean(args["clearAll"]))
            {
                ClearAllBlackouts();
                return GetMonitorsList();
            }

            int monitorIndex = args.ContainsKey("monitorIndex") ? Convert.ToInt32(args["monitorIndex"]) : 0;
            string mode = args.ContainsKey("mode") ? Convert.ToString(args["mode"]) : "toggle"; // "on", "off", "toggle"

            var monitors = GetMonitorsList();
            if (monitorIndex < 0 || monitorIndex >= monitors.Count)
                throw new Exception("Geçersiz monitör indeksi: " + monitorIndex);

            var targetMon = monitors[monitorIndex];

            if (uiDispatcherForm != null && uiDispatcherForm.IsHandleCreated)
            {
                uiDispatcherForm.Invoke((MethodInvoker)delegate
                {
                    lock (blackoutForms)
                    {
                        bool currentlyOn = blackoutForms.ContainsKey(monitorIndex) &&
                                           blackoutForms[monitorIndex] != null &&
                                           !blackoutForms[monitorIndex].IsDisposed &&
                                           blackoutForms[monitorIndex].Visible;

                        bool shouldBeOn = mode == "toggle" ? !currentlyOn : (mode == "on" || mode == "true");

                        if (!shouldBeOn)
                        {
                            if (blackoutForms.ContainsKey(monitorIndex) && blackoutForms[monitorIndex] != null)
                            {
                                try
                                {
                                    blackoutForms[monitorIndex].Hide();
                                    blackoutForms[monitorIndex].Close();
                                }
                                catch { }
                                blackoutForms.Remove(monitorIndex);
                            }
                        }
                        else
                        {
                            if (!currentlyOn)
                            {
                                Form bf = new Form
                                {
                                    FormBorderStyle = FormBorderStyle.None,
                                    StartPosition = FormStartPosition.Manual,
                                    BackColor = Color.Black,
                                    Bounds = new Rectangle(targetMon.x, targetMon.y, targetMon.width, targetMon.height),
                                    TopMost = true,
                                    ShowInTaskbar = false,
                                    KeyPreview = true
                                };
                                // Allow emergency wake on double-click or Escape key
                                bf.DoubleClick += (s, e) => { bf.Hide(); bf.Close(); };
                                bf.KeyDown += (s, e) =>
                                {
                                    if (e.KeyCode == Keys.Escape)
                                    {
                                        bf.Hide();
                                        bf.Close();
                                    }
                                };
                                bf.Show();
                                SetWindowPos(bf.Handle, new IntPtr(-1), targetMon.x, targetMon.y, targetMon.width, targetMon.height, SWP_SHOWWINDOW);
                                blackoutForms[monitorIndex] = bf;
                            }
                        }
                    }
                });
            }

            return GetMonitorsList();
        }

        private static object HandleDisplayTopology(Dictionary<string, object> args)
        {
            string mode = args.ContainsKey("mode") ? Convert.ToString(args["mode"]) : "extend";
            string flag = "/extend";
            if (mode == "internal" || mode == "primary_only") flag = "/internal";
            else if (mode == "external" || mode == "secondary_only") flag = "/external";
            else if (mode == "clone" || mode == "duplicate") flag = "/clone";

            Process.Start(new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "DisplaySwitch.exe"),
                Arguments = flag,
                CreateNoWindow = true,
                UseShellExecute = false
            });
            return new { mode = mode, applied = true };
        }

        #endregion

        #region Window & Scene Management

        private static object iconCacheLock = new object();
        private static Dictionary<string, string> iconCache = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        public static void ResolveShortcutInfo(string lnkPath, out string targetPath, out string arguments, out string iconPath, out int iconIndex)
        {
            targetPath = "";
            arguments = "";
            iconPath = "";
            iconIndex = 0;
            if (string.IsNullOrEmpty(lnkPath) || !File.Exists(lnkPath)) return;

            try
            {
                IShellLinkW link = (IShellLinkW)(new ShellLinkComObject());
                IPersistFile file = (IPersistFile)link;
                file.Load(lnkPath, 0);

                StringBuilder sbTarget = new StringBuilder(520);
                link.GetPath(sbTarget, sbTarget.Capacity, IntPtr.Zero, 0);
                targetPath = Environment.ExpandEnvironmentVariables(sbTarget.ToString().Trim());

                StringBuilder sbArgs = new StringBuilder(520);
                link.GetArguments(sbArgs, sbArgs.Capacity);
                arguments = sbArgs.ToString().Trim();

                StringBuilder sbIcon = new StringBuilder(520);
                int idx = 0;
                link.GetIconLocation(sbIcon, sbIcon.Capacity, out idx);
                string rawIcon = Environment.ExpandEnvironmentVariables(sbIcon.ToString().Trim().Trim('"'));
                if (!string.IsNullOrEmpty(rawIcon) && File.Exists(rawIcon))
                {
                    iconPath = rawIcon;
                    iconIndex = idx;
                }
            }
            catch { }
        }

        public static void ParseInternetShortcutUrl(string urlFilePath, out string urlTarget, out string iconFile, out int iconIndex)
        {
            urlTarget = "";
            iconFile = "";
            iconIndex = 0;
            if (string.IsNullOrEmpty(urlFilePath) || !File.Exists(urlFilePath)) return;
            try
            {
                foreach (var line in File.ReadAllLines(urlFilePath))
                {
                    string t = line.Trim();
                    if (t.StartsWith("URL=", StringComparison.OrdinalIgnoreCase))
                        urlTarget = t.Substring(4).Trim();
                    else if (t.StartsWith("IconFile=", StringComparison.OrdinalIgnoreCase))
                        iconFile = Environment.ExpandEnvironmentVariables(t.Substring(9).Trim().Trim('"'));
                    else if (t.StartsWith("IconIndex=", StringComparison.OrdinalIgnoreCase))
                        int.TryParse(t.Substring(10).Trim(), out iconIndex);
                }
            }
            catch { }
        }

        private static string ResolveRealExeForIcon(string rawPath, out int iconIndex)
        {
            iconIndex = 0;
            if (string.IsNullOrEmpty(rawPath)) return "";
            string clean = Environment.ExpandEnvironmentVariables(rawPath.Trim().Trim('"')).Replace('/', '\\');

            // Handle "C:\path\app.exe,0" format from Registry DisplayIcon
            int commaIdx = clean.LastIndexOf(',');
            if (commaIdx > 2 && commaIdx < clean.Length - 1)
            {
                string rightPart = clean.Substring(commaIdx + 1).Trim();
                int parsedIdx;
                if (int.TryParse(rightPart, out parsedIdx))
                {
                    clean = clean.Substring(0, commaIdx).Trim().Trim('"');
                    iconIndex = parsedIdx;
                }
            }

            try
            {
                if (clean.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase) && File.Exists(clean))
                {
                    string lnkTarget, lnkArgs, lnkIcon;
                    int lnkIconIdx;
                    ResolveShortcutInfo(clean, out lnkTarget, out lnkArgs, out lnkIcon, out lnkIconIdx);
                    if (!string.IsNullOrEmpty(lnkIcon) && File.Exists(lnkIcon) && !lnkIcon.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase))
                    {
                        iconIndex = lnkIconIdx;
                        clean = lnkIcon;
                    }
                    else if (!string.IsNullOrEmpty(lnkTarget) && File.Exists(lnkTarget))
                    {
                        clean = lnkTarget;
                    }
                }
                else if (clean.EndsWith(".url", StringComparison.OrdinalIgnoreCase) && File.Exists(clean))
                {
                    string uTarget, uIcon;
                    int uIdx;
                    ParseInternetShortcutUrl(clean, out uTarget, out uIcon, out uIdx);
                    if (!string.IsNullOrEmpty(uIcon) && File.Exists(uIcon))
                    {
                        iconIndex = uIdx;
                        clean = uIcon;
                    }
                }

                if (!clean.Contains("\\") && clean.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                {
                    string sysCand = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), clean);
                    if (File.Exists(sysCand)) clean = sysCand;
                    else
                    {
                        string winCand = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), clean);
                        if (File.Exists(winCand)) clean = winCand;
                    }
                }

                if (clean.EndsWith("Update.exe", StringComparison.OrdinalIgnoreCase))
                {
                    string parentDir = Path.GetDirectoryName(clean);
                    if (!string.IsNullOrEmpty(parentDir) && Directory.Exists(parentDir))
                    {
                        foreach (var sub in Directory.GetDirectories(parentDir, "app-*"))
                        {
                            foreach (var exe in Directory.GetFiles(sub, "*.exe"))
                            {
                                string exeName = Path.GetFileName(exe);
                                if (!exeName.Equals("Update.exe", StringComparison.OrdinalIgnoreCase) &&
                                    !exeName.StartsWith("squirrel", StringComparison.OrdinalIgnoreCase))
                                {
                                    iconIndex = 0;
                                    return exe;
                                }
                            }
                        }
                        string appIco = Path.Combine(parentDir, "app.ico");
                        if (File.Exists(appIco))
                        {
                            iconIndex = 0;
                            return appIco;
                        }
                    }
                }
            }
            catch { }
            return clean;
        }

        public static string GetAppIconBase64(string rawPath)
        {
            if (string.IsNullOrWhiteSpace(rawPath)) return "";
            lock (iconCacheLock)
            {
                if (iconCache.ContainsKey(rawPath))
                    return iconCache[rawPath];
            }

            string resultDataUrl = "";
            try
            {
                int iconIdx = 0;
                string resolved = ResolveRealExeForIcon(rawPath, out iconIdx);

                // Never extract from a .lnk file directly so we never get Windows shortcut overlay arrows
                if (!string.IsNullOrEmpty(resolved) &&
                    File.Exists(resolved) &&
                    !resolved.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase))
                {
                    IntPtr hHighResIcon = IntPtr.Zero;
                    try
                    {
                        IntPtr[] phicon = new IntPtr[1];
                        uint[] piconid = new uint[1];
                        uint count = PrivateExtractIconsW(resolved, iconIdx, 128, 128, phicon, piconid, 1, 0);
                        if ((count == 0 || phicon[0] == IntPtr.Zero) && iconIdx != 0)
                        {
                            count = PrivateExtractIconsW(resolved, 0, 128, 128, phicon, piconid, 1, 0);
                        }
                        if (count > 0 && phicon[0] != IntPtr.Zero)
                        {
                            hHighResIcon = phicon[0];
                        }
                    }
                    catch { }

                    if (hHighResIcon != IntPtr.Zero)
                    {
                        try
                        {
                            using (Icon ico = Icon.FromHandle(hHighResIcon))
                            using (Bitmap bmp = new Bitmap(96, 96, PixelFormat.Format32bppArgb))
                            {
                                using (Graphics g = Graphics.FromImage(bmp))
                                {
                                    g.Clear(Color.Transparent);
                                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                                    g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
                                    g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                                    g.DrawIcon(ico, new Rectangle(0, 0, 96, 96));
                                }
                                using (MemoryStream ms = new MemoryStream())
                                {
                                    bmp.Save(ms, ImageFormat.Png);
                                    resultDataUrl = "data:image/png;base64," + Convert.ToBase64String(ms.ToArray());
                                }
                            }
                        }
                        finally
                        {
                            DestroyIcon(hHighResIcon);
                        }
                    }
                    else if (resolved.EndsWith(".ico", StringComparison.OrdinalIgnoreCase) ||
                             resolved.EndsWith(".png", StringComparison.OrdinalIgnoreCase))
                    {
                        try
                        {
                            using (Icon ico = new Icon(resolved, 128, 128))
                            using (Bitmap bmp = new Bitmap(96, 96, PixelFormat.Format32bppArgb))
                            {
                                using (Graphics g = Graphics.FromImage(bmp))
                                {
                                    g.Clear(Color.Transparent);
                                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                                    g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
                                    g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                                    g.DrawIcon(ico, new Rectangle(0, 0, 96, 96));
                                }
                                using (MemoryStream ms = new MemoryStream())
                                {
                                    bmp.Save(ms, ImageFormat.Png);
                                    resultDataUrl = "data:image/png;base64," + Convert.ToBase64String(ms.ToArray());
                                }
                            }
                        }
                        catch
                        {
                            try
                            {
                                using (Image img = Image.FromFile(resolved))
                                using (Bitmap bmp = new Bitmap(96, 96, PixelFormat.Format32bppArgb))
                                {
                                    using (Graphics g = Graphics.FromImage(bmp))
                                    {
                                        g.Clear(Color.Transparent);
                                        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                                        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
                                        g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                                        g.DrawImage(img, new Rectangle(0, 0, 96, 96));
                                    }
                                    using (MemoryStream ms = new MemoryStream())
                                    {
                                        bmp.Save(ms, ImageFormat.Png);
                                        resultDataUrl = "data:image/png;base64," + Convert.ToBase64String(ms.ToArray());
                                    }
                                }
                            }
                            catch { }
                        }
                    }

                    if (string.IsNullOrEmpty(resultDataUrl))
                    {
                        using (Icon ico = Icon.ExtractAssociatedIcon(resolved))
                        {
                            if (ico != null)
                            {
                                using (Bitmap bmp = new Bitmap(96, 96, PixelFormat.Format32bppArgb))
                                {
                                    using (Graphics g = Graphics.FromImage(bmp))
                                    {
                                        g.Clear(Color.Transparent);
                                        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                                        g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
                                        g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                                        g.DrawIcon(ico, new Rectangle(0, 0, 96, 96));
                                    }
                                    using (MemoryStream ms = new MemoryStream())
                                    {
                                        bmp.Save(ms, ImageFormat.Png);
                                        resultDataUrl = "data:image/png;base64," + Convert.ToBase64String(ms.ToArray());
                                    }
                                }
                            }
                        }
                    }
                }
            }
            catch { }

            lock (iconCacheLock)
            {
                iconCache[rawPath] = resultDataUrl;
            }
            return resultDataUrl;
        }

        public static List<Dictionary<string, object>> GetOpenWindows()
        {
            var monitors = GetMonitorsList();
            var results = new List<Dictionary<string, object>>();
            var foregroundRectsByMonitor = new Dictionary<int, List<RECT>>();
            int zOrderCounter = 0;

            EnumWindows((hWnd, lParam) =>
            {
                if (!IsWindowVisible(hWnd)) return true;

                int length = GetWindowTextLength(hWnd);
                if (length == 0) return true;

                int exStyle = GetWindowLong(hWnd, GWL_EXSTYLE);
                if ((exStyle & WS_EX_TOOLWINDOW) != 0 && (exStyle & WS_EX_APPWINDOW) == 0)
                    return true;

                // Skip cloaked UWP background windows
                int cloaked = 0;
                if (DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0 && cloaked != 0)
                    return true;

                StringBuilder sb = new StringBuilder(length + 1);
                GetWindowText(hWnd, sb, sb.Capacity);
                string title = sb.ToString();
                if (title == "Program Manager" || title == "Windows Input Experience")
                    return true;

                uint pid = 0;
                GetWindowThreadProcessId(hWnd, out pid);
                string procName = "";
                string exePath = "";
                try
                {
                    Process p = Process.GetProcessById((int)pid);
                    procName = p.ProcessName;
                    try { exePath = p.MainModule.FileName; } catch { }
                }
                catch { return true; }

                // Skip our own blackout overlay windows or system shell hosts
                if (procName.Equals("BridgeHelper", StringComparison.OrdinalIgnoreCase) ||
                    procName.Equals("Bridge", StringComparison.OrdinalIgnoreCase) ||
                    procName.Equals("TahaBLTBridge", StringComparison.OrdinalIgnoreCase) ||
                    procName.Equals("TahaBLT-Connect", StringComparison.OrdinalIgnoreCase) ||
                    procName.Equals("TextInputHost", StringComparison.OrdinalIgnoreCase) ||
                    procName.Equals("SearchHost", StringComparison.OrdinalIgnoreCase))
                    return true;

                WINDOWPLACEMENT wp = new WINDOWPLACEMENT();
                wp.length = Marshal.SizeOf(wp);
                GetWindowPlacement(hWnd, ref wp);

                string state = "normal";
                if (wp.showCmd == SW_SHOWMINIMIZED || wp.showCmd == SW_MINIMIZE) state = "minimized";
                else if (wp.showCmd == SW_SHOWMAXIMIZED) state = "maximized";

                RECT winRect;
                if (state == "minimized")
                {
                    winRect = wp.rcNormalPosition;
                }
                else if (DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out winRect, Marshal.SizeOf(typeof(RECT))) != 0)
                {
                    GetWindowRect(hWnd, out winRect);
                }

                int w = Math.Max(200, winRect.Right - winRect.Left);
                int h = Math.Max(120, winRect.Bottom - winRect.Top);
                if (state != "minimized" && ((winRect.Right - winRect.Left) < 80 || (winRect.Bottom - winRect.Top) < 50))
                    return true;

                // Determine which monitor this window belongs to (even when minimized)
                int monIdx = 0;
                IntPtr hMon = MonitorFromWindow(hWnd, 2); // MONITOR_DEFAULTTONEAREST
                MONITORINFOEX mi = new MONITORINFOEX();
                mi.cbSize = Marshal.SizeOf(mi);
                if (hMon != IntPtr.Zero && GetMonitorInfo(hMon, ref mi))
                {
                    for (int i = 0; i < monitors.Count; i++)
                    {
                        if (string.Equals(monitors[i].deviceName, mi.szDevice, StringComparison.OrdinalIgnoreCase) ||
                            (Math.Abs(monitors[i].x - mi.rcMonitor.Left) < 10 && Math.Abs(monitors[i].y - mi.rcMonitor.Top) < 10))
                        {
                            monIdx = i;
                            break;
                        }
                    }
                }
                else
                {
                    int centerX = (winRect.Left + winRect.Right) / 2;
                    int centerY = (winRect.Top + winRect.Bottom) / 2;
                    for (int i = 0; i < monitors.Count; i++)
                    {
                        var m = monitors[i];
                        if (centerX >= m.x && centerX < m.x + m.width &&
                            centerY >= m.y && centerY < m.y + m.height)
                        {
                            monIdx = i;
                            break;
                        }
                    }
                }

                var targetMon = monitors.Count > monIdx ? monitors[monIdx] : new MonitorData { workX = 0, workY = 0, workWidth = 1920, workHeight = 1080 };
                double normX = Math.Max(0, Math.Min(1, Math.Round((double)(winRect.Left - targetMon.workX) / Math.Max(1, targetMon.workWidth), 2)));
                double normY = Math.Max(0, Math.Min(1, Math.Round((double)(winRect.Top - targetMon.workY) / Math.Max(1, targetMon.workHeight), 2)));
                double normW = Math.Max(0.1, Math.Min(1, Math.Round((double)w / Math.Max(1, targetMon.workWidth), 2)));
                double normH = Math.Max(0.1, Math.Min(1, Math.Round((double)h / Math.Max(1, targetMon.workHeight), 2)));

                if (state == "maximized")
                {
                    normX = 0; normY = 0; normW = 1; normH = 1;
                }

                int currentZOrder = zOrderCounter++;

                // Determine if window is in background (minimized or occluded by a higher Z-order window on the same monitor)
                bool isBackground = false;
                string backgroundReason = "";
                if (state == "minimized")
                {
                    isBackground = true;
                    backgroundReason = "Simge Durumunda";
                }
                else
                {
                    if (!foregroundRectsByMonitor.ContainsKey(monIdx))
                        foregroundRectsByMonitor[monIdx] = new List<RECT>();

                    int cx = (winRect.Left + winRect.Right) / 2;
                    int cy = (winRect.Top + winRect.Bottom) / 2;
                    foreach (var above in foregroundRectsByMonitor[monIdx])
                    {
                        int ix1 = Math.Max(winRect.Left, above.Left);
                        int iy1 = Math.Max(winRect.Top, above.Top);
                        int ix2 = Math.Min(winRect.Right, above.Right);
                        int iy2 = Math.Min(winRect.Bottom, above.Bottom);
                        long interArea = (ix2 > ix1 && iy2 > iy1) ? (long)(ix2 - ix1) * (iy2 - iy1) : 0;
                        long selfArea = Math.Max(1L, (long)w * h);

                        if ((cx >= above.Left && cx <= above.Right && cy >= above.Top && cy <= above.Bottom) ||
                            (interArea * 100 / selfArea >= 25))
                        {
                            isBackground = true;
                            backgroundReason = "Arkaplanda";
                            break;
                        }
                    }

                    RECT effectiveRect = state == "maximized"
                        ? new RECT { Left = targetMon.x, Top = targetMon.y, Right = targetMon.x + targetMon.width, Bottom = targetMon.y + targetMon.height }
                        : winRect;
                    foregroundRectsByMonitor[monIdx].Add(effectiveRect);
                }

                string zonePreset = ClassifyZone(state, normX, normY, normW, normH);
                bool isTopMost = (exStyle & WS_EX_TOPMOST) != 0;

                EnsureMsixCatalogLoaded();
                string rawProcName = procName;
                string iconSourceForWin = exePath;
                MsixAppEntry msixMatch = null;
                lock (msixCatalogLock)
                {
                    if (!string.IsNullOrEmpty(procName) && msixAppsByProcName.ContainsKey(procName))
                    {
                        msixMatch = msixAppsByProcName[procName];
                    }
                }
                if (msixMatch != null)
                {
                    if (!string.IsNullOrEmpty(msixMatch.DisplayName))
                        procName = msixMatch.DisplayName;
                    if (!string.IsNullOrEmpty(msixMatch.IconPngPath) && File.Exists(msixMatch.IconPngPath))
                        iconSourceForWin = msixMatch.IconPngPath;
                }
                else if (procName.Equals("WhatsApp.Root", StringComparison.OrdinalIgnoreCase))
                {
                    procName = "WhatsApp";
                }

                string iconBase64 = GetAppIconBase64(iconSourceForWin);
                if (string.IsNullOrEmpty(iconBase64) && !string.IsNullOrEmpty(exePath))
                {
                    iconBase64 = GetAppIconBase64(exePath);
                }

                results.Add(new Dictionary<string, object>
                {
                    { "hwnd", hWnd.ToInt64() },
                    { "title", title },
                    { "processName", procName },
                    { "rawProcessName", rawProcName },
                    { "exePath", exePath },
                    { "icon", iconBase64 },
                    { "pid", pid },
                    { "monitorIndex", monIdx },
                    { "zOrder", currentZOrder },
                    { "state", state },
                    { "isBackground", isBackground },
                    { "backgroundReason", backgroundReason },
                    { "isTopMost", isTopMost },
                    { "rect", new { x = winRect.Left, y = winRect.Top, width = w, height = h } },
                    { "normalized", new { x = normX, y = normY, w = normW, h = normH } },
                    { "zonePreset", zonePreset }
                });

                return true;
            }, IntPtr.Zero);

            return results;
        }

        private static string ClassifyZone(string state, double x, double y, double w, double h)
        {
            if (state == "maximized" || (w >= 0.92 && h >= 0.92)) return "fullscreen";
            if (Math.Abs(x - 0.0) < 0.08 && Math.Abs(y - 0.0) < 0.08 && Math.Abs(w - 0.5) < 0.1 && h >= 0.9) return "left-half";
            if (Math.Abs(x - 0.5) < 0.08 && Math.Abs(y - 0.0) < 0.08 && Math.Abs(w - 0.5) < 0.1 && h >= 0.9) return "right-half";
            if (Math.Abs(x - 0.0) < 0.08 && Math.Abs(y - 0.0) < 0.08 && w >= 0.9 && Math.Abs(h - 0.5) < 0.1) return "top-half";
            if (Math.Abs(x - 0.0) < 0.08 && Math.Abs(y - 0.5) < 0.08 && w >= 0.9 && Math.Abs(h - 0.5) < 0.1) return "bottom-half";
            if (Math.Abs(x - 0.0) < 0.08 && Math.Abs(y - 0.0) < 0.08 && Math.Abs(w - 0.5) < 0.1 && Math.Abs(h - 0.5) < 0.1) return "top-left";
            if (Math.Abs(x - 0.5) < 0.08 && Math.Abs(y - 0.0) < 0.08 && Math.Abs(w - 0.5) < 0.1 && Math.Abs(h - 0.5) < 0.1) return "top-right";
            if (Math.Abs(x - 0.0) < 0.08 && Math.Abs(y - 0.5) < 0.08 && Math.Abs(w - 0.5) < 0.1 && Math.Abs(h - 0.5) < 0.1) return "bottom-left";
            if (Math.Abs(x - 0.5) < 0.08 && Math.Abs(y - 0.5) < 0.08 && Math.Abs(w - 0.5) < 0.1 && Math.Abs(h - 0.5) < 0.1) return "bottom-right";
            return "custom";
        }

        private static object SnapWindowCommand(Dictionary<string, object> args)
        {
            long hwndLong = args.ContainsKey("hwnd") ? Convert.ToInt64(args["hwnd"]) : 0;
            string processName = args.ContainsKey("processName") ? Convert.ToString(args["processName"]) : "";
            int monitorIndex = args.ContainsKey("monitorIndex") ? Convert.ToInt32(args["monitorIndex"]) : 0;
            string state = args.ContainsKey("state") ? Convert.ToString(args["state"]) : "normal";
            bool noActivate = args.ContainsKey("noActivate") && Convert.ToBoolean(args["noActivate"]);
            string zonePreset = args.ContainsKey("zonePreset") ? Convert.ToString(args["zonePreset"]).Trim().ToLowerInvariant() : "";
            double normX = args.ContainsKey("x") ? Convert.ToDouble(args["x"]) : 0.0;
            double normY = args.ContainsKey("y") ? Convert.ToDouble(args["y"]) : 0.0;
            double normW = args.ContainsKey("w") ? Convert.ToDouble(args["w"]) : 1.0;
            double normH = args.ContainsKey("h") ? Convert.ToDouble(args["h"]) : 1.0;

            if (!string.IsNullOrEmpty(zonePreset) && zonePreset != "custom" && zonePreset != "none" && !args.ContainsKey("x"))
            {
                ResolveZoneRect(zonePreset, out normX, out normY, out normW, out normH, out state);
            }

            IntPtr targetHwnd = new IntPtr(hwndLong);
            if (targetHwnd == IntPtr.Zero && !string.IsNullOrEmpty(processName))
            {
                var openWins = GetOpenWindows();
                foreach (var w in openWins)
                {
                    string pName = Convert.ToString(w["processName"]);
                    string rawP = w.ContainsKey("rawProcessName") ? Convert.ToString(w["rawProcessName"]) : "";
                    if (pName.Equals(processName, StringComparison.OrdinalIgnoreCase) ||
                        (!string.IsNullOrEmpty(rawP) && rawP.Equals(processName, StringComparison.OrdinalIgnoreCase)) ||
                        pName.IndexOf(processName, StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        targetHwnd = new IntPtr(Convert.ToInt64(w["hwnd"]));
                        break;
                    }
                }
            }

            if (targetHwnd == IntPtr.Zero)
                return new { snapped = false, reason = "window_not_found" };

            var monitors = GetMonitorsList();
            if (monitors.Count == 0) return new { snapped = false, reason = "no_monitors" };
            if (monitorIndex < 0 || monitorIndex >= monitors.Count) monitorIndex = 0;

            var mon = monitors[monitorIndex];

            if (state == "minimized")
            {
                // Ensure the window's restored position belongs to the target monitor before minimizing
                WINDOWPLACEMENT wpMin = new WINDOWPLACEMENT();
                wpMin.length = Marshal.SizeOf(wpMin);
                if (GetWindowPlacement(targetHwnd, ref wpMin))
                {
                    int curW = Math.Max(400, wpMin.rcNormalPosition.Right - wpMin.rcNormalPosition.Left);
                    int curH = Math.Max(300, wpMin.rcNormalPosition.Bottom - wpMin.rcNormalPosition.Top);
                    int cx = (wpMin.rcNormalPosition.Left + wpMin.rcNormalPosition.Right) / 2;
                    int cy = (wpMin.rcNormalPosition.Top + wpMin.rcNormalPosition.Bottom) / 2;
                    if (cx < mon.x || cx >= mon.x + mon.width || cy < mon.y || cy >= mon.y + mon.height)
                    {
                        wpMin.rcNormalPosition.Left = mon.workX + Math.Max(0, (mon.workWidth - curW) / 2);
                        wpMin.rcNormalPosition.Top = mon.workY + Math.Max(0, (mon.workHeight - curH) / 2);
                        wpMin.rcNormalPosition.Right = wpMin.rcNormalPosition.Left + curW;
                        wpMin.rcNormalPosition.Bottom = wpMin.rcNormalPosition.Top + curH;
                        wpMin.showCmd = SW_SHOWMINNOACTIVE;
                        SetWindowPlacement(targetHwnd, ref wpMin);
                    }
                }
                ShowWindow(targetHwnd, SW_MINIMIZE);
                return new { snapped = true, hwnd = targetHwnd.ToInt64(), state = "minimized", monitorIndex = monitorIndex };
            }

            // Always restore first so moving across monitors works cleanly
            ShowWindow(targetHwnd, noActivate ? SW_SHOWNOACTIVATE : SW_RESTORE);
            Thread.Sleep(20);

            int targetX = mon.workX + (int)Math.Round(normX * mon.workWidth);
            int targetY = mon.workY + (int)Math.Round(normY * mon.workHeight);
            int targetW = (int)Math.Round(normW * mon.workWidth);
            int targetH = (int)Math.Round(normH * mon.workHeight);

            uint swpFlags = SWP_SHOWWINDOW | SWP_FRAMECHANGED | (noActivate ? SWP_NOACTIVATE : 0u);
            IntPtr zOrderPtr = HWND_TOP;

            // First rough move to target monitor so DWM frame bounds are calculated for that monitor's DPI
            SetWindowPos(targetHwnd, zOrderPtr, targetX, targetY, targetW, targetH, swpFlags);

            if (state == "maximized" || (normW >= 0.98 && normH >= 0.98 && normX <= 0.02 && normY <= 0.02))
            {
                ShowWindow(targetHwnd, SW_MAXIMIZE);
                if (!noActivate) ForceForeground(targetHwnd);
                else PromoteWindowZOrderNoActivate(targetHwnd);
                return new { snapped = true, hwnd = targetHwnd.ToInt64(), state = "maximized", monitorIndex = monitorIndex };
            }

            // DWM Invisible Border Compensation for 0-pixel gap snapping
            RECT winRect, extRect;
            if (GetWindowRect(targetHwnd, out winRect) &&
                DwmGetWindowAttribute(targetHwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out extRect, Marshal.SizeOf(typeof(RECT))) == 0)
            {
                int leftMargin = extRect.Left - winRect.Left;
                int topMargin = extRect.Top - winRect.Top;
                int rightMargin = winRect.Right - extRect.Right;
                int bottomMargin = winRect.Bottom - extRect.Bottom;

                targetX -= leftMargin;
                targetY -= topMargin;
                targetW += (leftMargin + rightMargin);
                targetH += (topMargin + bottomMargin);

                SetWindowPos(targetHwnd, zOrderPtr, targetX, targetY, targetW, targetH, swpFlags);
            }

            if (!noActivate)
            {
                ForceForeground(targetHwnd);
            }
            else
            {
                PromoteWindowZOrderNoActivate(targetHwnd);
            }
            return new
            {
                snapped = true,
                hwnd = targetHwnd.ToInt64(),
                monitorIndex = monitorIndex,
                rect = new { x = targetX, y = targetY, width = targetW, height = targetH }
            };
        }

        private static void PromoteWindowZOrderNoActivate(IntPtr hWnd)
        {
            try
            {
                bool wasTopMost = (GetWindowLong(hWnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
                SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
                if (!wasTopMost)
                {
                    SetWindowPos(hWnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
                }
            }
            catch { }
        }

        private static void ForceForeground(IntPtr hWnd)
        {
            try
            {
                bool wasTopMost = (GetWindowLong(hWnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
                SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                if (!wasTopMost)
                {
                    SetWindowPos(hWnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                }

                IntPtr fg = GetForegroundWindow();
                uint fgThread = 0, targetThread = 0, dummy = 0;
                fgThread = GetWindowThreadProcessId(fg, out dummy);
                targetThread = GetWindowThreadProcessId(hWnd, out dummy);
                if (fgThread != targetThread && fgThread != 0)
                {
                    AttachThreadInput(fgThread, targetThread, true);
                    BringWindowToTop(hWnd);
                    SetForegroundWindow(hWnd);
                    AttachThreadInput(fgThread, targetThread, false);
                }
                else
                {
                    BringWindowToTop(hWnd);
                    SetForegroundWindow(hWnd);
                }
            }
            catch { }
        }

        private static object FocusWindowCommand(Dictionary<string, object> args)
        {
            long hwndLong = args.ContainsKey("hwnd") ? Convert.ToInt64(args["hwnd"]) : 0;
            IntPtr hWnd = new IntPtr(hwndLong);
            if (hWnd == IntPtr.Zero) return new { ok = false };

            WINDOWPLACEMENT wp = new WINDOWPLACEMENT();
            wp.length = Marshal.SizeOf(wp);
            GetWindowPlacement(hWnd, ref wp);
            if (wp.showCmd == SW_SHOWMINIMIZED || wp.showCmd == SW_MINIMIZE)
                ShowWindow(hWnd, SW_RESTORE);

            ForceForeground(hWnd);
            return new { ok = true };
        }

        private static object CloseWindowCommand(Dictionary<string, object> args)
        {
            long hwndLong = args.ContainsKey("hwnd") ? Convert.ToInt64(args["hwnd"]) : 0;
            IntPtr hWnd = new IntPtr(hwndLong);
            if (hWnd == IntPtr.Zero) return new { ok = false };
            PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            return new { ok = true };
        }

        private static object WindowActionCommand(Dictionary<string, object> args)
        {
            long hwndLong = args.ContainsKey("hwnd") ? Convert.ToInt64(args["hwnd"]) : 0;
            string action = args.ContainsKey("action") ? Convert.ToString(args["action"]) : "focus";
            IntPtr hWnd = new IntPtr(hwndLong);
            if (hWnd == IntPtr.Zero) return new { ok = false };

            if (action == "minimize")
            {
                ShowWindow(hWnd, SW_MINIMIZE);
                return new { ok = true, action = "minimize" };
            }
            else if (action == "maximize")
            {
                ShowWindow(hWnd, SW_MAXIMIZE);
                ForceForeground(hWnd);
                return new { ok = true, action = "maximize" };
            }
            else if (action == "restore")
            {
                ShowWindow(hWnd, SW_RESTORE);
                ForceForeground(hWnd);
                return new { ok = true, action = "restore" };
            }
            else if (action == "close")
            {
                PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                return new { ok = true, action = "close" };
            }
            else if (action == "move_to_monitor")
            {
                int targetMonIdx = args.ContainsKey("monitorIndex") ? Convert.ToInt32(args["monitorIndex"]) : 0;
                WINDOWPLACEMENT wp = new WINDOWPLACEMENT();
                wp.length = Marshal.SizeOf(wp);
                GetWindowPlacement(hWnd, ref wp);
                bool wasMax = (wp.showCmd == SW_SHOWMAXIMIZED);

                var snapArgs = new Dictionary<string, object>
                {
                    { "hwnd", hwndLong },
                    { "monitorIndex", targetMonIdx },
                    { "state", wasMax ? "maximized" : "normal" },
                    { "x", wasMax ? 0.0 : 0.08 },
                    { "y", wasMax ? 0.0 : 0.08 },
                    { "w", wasMax ? 1.0 : 0.84 },
                    { "h", wasMax ? 1.0 : 0.84 }
                };
                return SnapWindowCommand(snapArgs);
            }
            else if (action == "snap_zone")
            {
                int targetMonIdx = args.ContainsKey("monitorIndex") ? Convert.ToInt32(args["monitorIndex"]) : 0;
                string zone = args.ContainsKey("zone") ? Convert.ToString(args["zone"]) : "full";
                double zx = 0.0, zy = 0.0, zw = 1.0, zh = 1.0;
                string zState = "normal";
                ResolveZoneRect(zone, out zx, out zy, out zw, out zh, out zState);

                var snapArgs = new Dictionary<string, object>
                {
                    { "hwnd", hwndLong },
                    { "monitorIndex", targetMonIdx },
                    { "state", zState },
                    { "x", zx },
                    { "y", zy },
                    { "w", zw },
                    { "h", zh }
                };
                return SnapWindowCommand(snapArgs);
            }
            else if (action == "toggle_topmost")
            {
                int exStyle = GetWindowLong(hWnd, GWL_EXSTYLE);
                bool currentlyTop = (exStyle & WS_EX_TOPMOST) != 0;
                bool nextTop = args.ContainsKey("topMost") ? Convert.ToBoolean(args["topMost"]) : !currentlyTop;
                SetWindowPos(hWnd, nextTop ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                return new { ok = true, action = "toggle_topmost", isTopMost = nextTop };
            }
            else if (action == "set_opacity")
            {
                int pct = args.ContainsKey("opacity") ? Convert.ToInt32(args["opacity"]) : 100;
                pct = Math.Max(25, Math.Min(100, pct));
                int exStyle = GetWindowLong(hWnd, GWL_EXSTYLE);
                SetWindowLong(hWnd, GWL_EXSTYLE, exStyle | WS_EX_LAYERED);
                byte alpha = (byte)Math.Round(pct * 255.0 / 100.0);
                SetLayeredWindowAttributes(hWnd, 0, alpha, LWA_ALPHA);
                return new { ok = true, action = "set_opacity", opacity = pct };
            }
            else if (action == "open_file_location")
            {
                uint pid = 0;
                GetWindowThreadProcessId(hWnd, out pid);
                string exe = "";
                try { exe = Process.GetProcessById((int)pid).MainModule.FileName; } catch { }
                if (!string.IsNullOrEmpty(exe) && File.Exists(exe))
                {
                    Process.Start(new ProcessStartInfo("explorer.exe", "/select,\"" + exe + "\"") { UseShellExecute = true });
                    return new { ok = true, path = exe };
                }
                return new { ok = false };
            }
            else if (action == "kill_process")
            {
                uint pid = 0;
                GetWindowThreadProcessId(hWnd, out pid);
                if (pid != 0)
                {
                    try
                    {
                        Process.GetProcessById((int)pid).Kill();
                        return new { ok = true, pid = pid };
                    }
                    catch (Exception ex) { return new { ok = false, error = ex.Message }; }
                }
                return new { ok = false };
            }

            return FocusWindowCommand(args);
        }

        private static void ResolveZoneRect(string zone, out double zx, out double zy, out double zw, out double zh, out string zState)
        {
            zx = 0.08; zy = 0.08; zw = 0.84; zh = 0.84; zState = "normal";
            if (string.IsNullOrEmpty(zone) || zone == "none") return;
            switch (zone.ToLowerInvariant())
            {
                case "full":
                case "fullscreen":
                case "maximized":
                    zx = 0.0; zy = 0.0; zw = 1.0; zh = 1.0; zState = "maximized";
                    break;
                case "left-half":
                    zx = 0.0; zy = 0.0; zw = 0.5; zh = 1.0;
                    break;
                case "right-half":
                    zx = 0.5; zy = 0.0; zw = 0.5; zh = 1.0;
                    break;
                case "top-half":
                    zx = 0.0; zy = 0.0; zw = 1.0; zh = 0.5;
                    break;
                case "bottom-half":
                    zx = 0.0; zy = 0.5; zw = 1.0; zh = 0.5;
                    break;
                case "top-left":
                    zx = 0.0; zy = 0.0; zw = 0.5; zh = 0.5;
                    break;
                case "top-right":
                    zx = 0.5; zy = 0.0; zw = 0.5; zh = 0.5;
                    break;
                case "bottom-left":
                    zx = 0.0; zy = 0.5; zw = 0.5; zh = 0.5;
                    break;
                case "bottom-right":
                    zx = 0.5; zy = 0.5; zw = 0.5; zh = 0.5;
                    break;
                case "center":
                    zx = 0.12; zy = 0.10; zw = 0.76; zh = 0.80;
                    break;
            }
        }

        private static void QueryExtensionAssociation(string ext, out string friendlyApp, out string executablePath)
        {
            friendlyApp = "";
            executablePath = "";
            if (string.IsNullOrEmpty(ext) || !ext.StartsWith(".")) return;
            try
            {
                uint cch1 = 260;
                StringBuilder sb1 = new StringBuilder((int)cch1);
                if (AssocQueryString(0, 4, ext, "open", sb1, ref cch1) == 0)
                    friendlyApp = sb1.ToString();

                uint cch2 = 520;
                StringBuilder sb2 = new StringBuilder((int)cch2);
                if (AssocQueryString(0, 2, ext, "open", sb2, ref cch2) == 0)
                    executablePath = sb2.ToString();
            }
            catch { }
        }

        private static string FormatFileSize(long bytes)
        {
            if (bytes < 1024) return bytes + " B";
            double kb = bytes / 1024.0;
            if (kb < 1024) return Math.Round(kb, 1) + " KB";
            double mb = kb / 1024.0;
            if (mb < 1024) return Math.Round(mb, 1) + " MB";
            double gb = mb / 1024.0;
            return Math.Round(gb, 2) + " GB";
        }

        private static object BrowseFileSystemCommand(Dictionary<string, object> args)
        {
            string rawPath = args.ContainsKey("path") ? Convert.ToString(args["path"]).Trim() : "";
            string filter = args.ContainsKey("query") ? Convert.ToString(args["query"]).Trim() : "";

            string userProf = GetInteractiveUserProfilePath();
            string desktopDir = Path.Combine(userProf, "Desktop");
            if (!Directory.Exists(desktopDir))
            {
                desktopDir = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            }
            string localDesktop = Path.Combine(userProf, "Desktop");
            try
            {
                if ((!Directory.Exists(desktopDir) || (Directory.GetFiles(desktopDir).Length == 0 && Directory.GetDirectories(desktopDir).Length == 0)) &&
                    Directory.Exists(localDesktop))
                {
                    desktopDir = localDesktop;
                }
            }
            catch { }

            string downloadsDir = Path.Combine(userProf, "Downloads");
            string documentsDir = Path.Combine(userProf, "Documents");
            string recentDir = Path.Combine(userProf, @"AppData\Roaming\Microsoft\Windows\Recent");

            var roots = new List<Dictionary<string, object>>
            {
                new Dictionary<string, object> { { "label", "Masaüstü" }, { "path", desktopDir }, { "kind", "special" } },
                new Dictionary<string, object> { { "label", "İndirilenler" }, { "path", downloadsDir }, { "kind", "special" } },
                new Dictionary<string, object> { { "label", "Belgeler" }, { "path", documentsDir }, { "kind", "special" } }
            };

            if (Directory.Exists(@"C:\Taha"))
            {
                roots.Add(new Dictionary<string, object> { { "label", "C:\\Taha" }, { "path", @"C:\Taha" }, { "kind", "special" } });
            }
            roots.Add(new Dictionary<string, object> { { "label", "Son Kullanılanlar" }, { "path", recentDir }, { "kind", "special" } });

            foreach (var d in DriveInfo.GetDrives())
            {
                try
                {
                    if (!d.IsReady) continue;
                    double freeGb = Math.Round(d.AvailableFreeSpace / (1024.0 * 1024.0 * 1024.0), 1);
                    double totalGb = Math.Round(d.TotalSize / (1024.0 * 1024.0 * 1024.0), 1);
                    roots.Add(new Dictionary<string, object>
                    {
                        { "label", d.Name.TrimEnd('\\') + " (" + freeGb + " GB boş)" },
                        { "path", d.RootDirectory.FullName },
                        { "kind", "drive" },
                        { "freeGb", freeGb },
                        { "totalGb", totalGb }
                    });
                }
                catch { }
            }

            string targetDir = rawPath;
            if (string.IsNullOrEmpty(targetDir) || targetDir == "quick:desktop")
                targetDir = desktopDir;
            else if (targetDir == "quick:downloads")
                targetDir = downloadsDir;
            else if (targetDir == "quick:documents")
                targetDir = documentsDir;
            else if (targetDir == "quick:recent")
                targetDir = recentDir;
            else if (targetDir == "quick:taha" && Directory.Exists(@"C:\Taha"))
                targetDir = @"C:\Taha";

            if (!Directory.Exists(targetDir))
            {
                targetDir = Directory.Exists(@"C:\Taha") ? @"C:\Taha" : desktopDir;
            }

            string parentDir = "";
            try
            {
                var p = Directory.GetParent(targetDir);
                if (p != null) parentDir = p.FullName;
            }
            catch { }

            var entries = new List<Dictionary<string, object>>();

            // 1. Directories
            try
            {
                var dirs = Directory.GetDirectories(targetDir);
                Array.Sort(dirs, StringComparer.OrdinalIgnoreCase);
                foreach (var dirPath in dirs)
                {
                    try
                    {
                        DirectoryInfo di = new DirectoryInfo(dirPath);
                        if ((di.Attributes & FileAttributes.Hidden) != 0 && (di.Attributes & FileAttributes.System) != 0)
                            continue;
                        if (!string.IsNullOrEmpty(filter) && di.Name.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0)
                            continue;

                        entries.Add(new Dictionary<string, object>
                        {
                            { "name", di.Name },
                            { "path", di.FullName },
                            { "isDir", true },
                            { "targetType", "folder" },
                            { "ext", "KLASÖR" },
                            { "sizeBytes", 0L },
                            { "sizeFormatted", "Klasör" },
                            { "modifiedAt", di.LastWriteTime.ToString("dd.MM.yyyy HH:mm") },
                            { "defaultAppName", "Windows Gezgini" },
                            { "defaultAppExe", "explorer.exe" }
                        });
                    }
                    catch { }
                }
            }
            catch { }

            // 2. Files
            var extCache = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase);
            try
            {
                var files = Directory.GetFiles(targetDir);
                Array.Sort(files, StringComparer.OrdinalIgnoreCase);
                int count = 0;
                foreach (var filePath in files)
                {
                    if (count >= 160) break;
                    try
                    {
                        FileInfo fi = new FileInfo(filePath);
                        if (fi.Name.Equals("desktop.ini", StringComparison.OrdinalIgnoreCase) ||
                            fi.Name.Equals("thumbs.db", StringComparison.OrdinalIgnoreCase))
                            continue;
                        if (!string.IsNullOrEmpty(filter) && fi.Name.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0)
                            continue;

                        string ext = (fi.Extension ?? "").ToLowerInvariant();
                        string defName = "";
                        string defExe = "";
                        if (!string.IsNullOrEmpty(ext))
                        {
                            if (!extCache.ContainsKey(ext))
                            {
                                QueryExtensionAssociation(ext, out defName, out defExe);
                                extCache[ext] = new string[] { defName, defExe };
                            }
                            else
                            {
                                defName = extCache[ext][0];
                                defExe = extCache[ext][1];
                            }
                        }

                        string tType = (ext == ".exe" || ext == ".bat" || ext == ".cmd" || ext == ".ps1") ? "app" : "file";
                        entries.Add(new Dictionary<string, object>
                        {
                            { "name", fi.Name },
                            { "path", fi.FullName },
                            { "isDir", false },
                            { "targetType", tType },
                            { "ext", string.IsNullOrEmpty(ext) ? "DOSYA" : ext.TrimStart('.').ToUpperInvariant() },
                            { "sizeBytes", fi.Length },
                            { "sizeFormatted", FormatFileSize(fi.Length) },
                            { "modifiedAt", fi.LastWriteTime.ToString("dd.MM.yyyy HH:mm") },
                            { "defaultAppName", string.IsNullOrEmpty(defName) ? "Windows Varsayılanı" : defName },
                            { "defaultAppExe", defExe }
                        });
                        count++;
                    }
                    catch { }
                }
            }
            catch { }

            return new
            {
                currentPath = targetDir,
                parentPath = parentDir,
                roots = roots,
                entries = entries
            };
        }

        private static object InspectTargetCommand(Dictionary<string, object> args)
        {
            string rawPath = args.ContainsKey("path") ? Convert.ToString(args["path"]).Trim() : "";
            long hwndLong = args.ContainsKey("hwnd") ? Convert.ToInt64(args["hwnd"]) : 0;

            var info = new Dictionary<string, object>
            {
                { "path", rawPath },
                { "hwnd", hwndLong },
                { "exists", false },
                { "isDir", false },
                { "isUrl", false },
                { "targetType", "file" },
                { "name", "" },
                { "fullPath", rawPath },
                { "directory", "" },
                { "extension", "" },
                { "sizeBytes", 0L },
                { "sizeFormatted", "-" },
                { "createdAt", "-" },
                { "modifiedAt", "-" },
                { "productName", "" },
                { "fileDescription", "" },
                { "fileVersion", "" },
                { "companyName", "" },
                { "defaultAppName", "Windows Varsayılanı" },
                { "defaultAppExe", "" }
            };

            if (hwndLong != 0)
            {
                IntPtr hWnd = new IntPtr(hwndLong);
                int len = GetWindowTextLength(hWnd);
                StringBuilder sb = new StringBuilder(len + 1);
                GetWindowText(hWnd, sb, sb.Capacity);
                info["windowTitle"] = sb.ToString();

                uint pid = 0;
                GetWindowThreadProcessId(hWnd, out pid);
                info["pid"] = pid;

                int exStyle = GetWindowLong(hWnd, GWL_EXSTYLE);
                info["isTopMost"] = (exStyle & WS_EX_TOPMOST) != 0;

                RECT winRect;
                if (DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out winRect, Marshal.SizeOf(typeof(RECT))) != 0)
                    GetWindowRect(hWnd, out winRect);
                info["rect"] = new { x = winRect.Left, y = winRect.Top, width = winRect.Right - winRect.Left, height = winRect.Bottom - winRect.Top };

                try
                {
                    Process p = Process.GetProcessById((int)pid);
                    info["processName"] = p.ProcessName;
                    try
                    {
                        if (string.IsNullOrEmpty(rawPath))
                        {
                            rawPath = p.MainModule.FileName;
                            info["path"] = rawPath;
                            info["fullPath"] = rawPath;
                        }
                    }
                    catch { }
                }
                catch { }
            }

            if (!string.IsNullOrEmpty(rawPath))
            {
                if (rawPath.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                    rawPath.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                {
                    info["exists"] = true;
                    info["isUrl"] = true;
                    info["targetType"] = "url";
                    info["name"] = rawPath;
                    info["extension"] = "URL";
                    string defName, defExe;
                    QueryExtensionAssociation(".html", out defName, out defExe);
                    if (!string.IsNullOrEmpty(defName)) info["defaultAppName"] = defName;
                    if (!string.IsNullOrEmpty(defExe)) info["defaultAppExe"] = defExe;
                }
                else if (Directory.Exists(rawPath))
                {
                    DirectoryInfo di = new DirectoryInfo(rawPath);
                    info["exists"] = true;
                    info["isDir"] = true;
                    info["targetType"] = "folder";
                    info["name"] = di.Name;
                    info["fullPath"] = di.FullName;
                    info["directory"] = di.Parent != null ? di.Parent.FullName : di.FullName;
                    info["extension"] = "KLASÖR";
                    info["createdAt"] = di.CreationTime.ToString("dd.MM.yyyy HH:mm");
                    info["modifiedAt"] = di.LastWriteTime.ToString("dd.MM.yyyy HH:mm");
                    info["defaultAppName"] = "Windows Gezgini (Explorer)";
                    info["defaultAppExe"] = "explorer.exe";
                    try
                    {
                        int fCount = Directory.GetFiles(rawPath).Length;
                        int dCount = Directory.GetDirectories(rawPath).Length;
                        info["sizeFormatted"] = dCount + " klasör, " + fCount + " dosya";
                    }
                    catch { info["sizeFormatted"] = "Klasör"; }
                }
                else if (File.Exists(rawPath))
                {
                    FileInfo fi = new FileInfo(rawPath);
                    string ext = (fi.Extension ?? "").ToLowerInvariant();
                    info["exists"] = true;
                    info["isDir"] = false;
                    info["targetType"] = (ext == ".exe" || ext == ".bat" || ext == ".cmd") ? "app" : "file";
                    info["name"] = fi.Name;
                    info["fullPath"] = fi.FullName;
                    info["directory"] = fi.DirectoryName ?? "";
                    info["extension"] = string.IsNullOrEmpty(ext) ? "DOSYA" : ext.TrimStart('.').ToUpperInvariant();
                    info["sizeBytes"] = fi.Length;
                    info["sizeFormatted"] = FormatFileSize(fi.Length);
                    info["createdAt"] = fi.CreationTime.ToString("dd.MM.yyyy HH:mm");
                    info["modifiedAt"] = fi.LastWriteTime.ToString("dd.MM.yyyy HH:mm");

                    string defName, defExe;
                    QueryExtensionAssociation(ext, out defName, out defExe);
                    if (!string.IsNullOrEmpty(defName)) info["defaultAppName"] = defName;
                    if (!string.IsNullOrEmpty(defExe)) info["defaultAppExe"] = defExe;

                    try
                    {
                        FileVersionInfo fvi = FileVersionInfo.GetVersionInfo(fi.FullName);
                        info["productName"] = fvi.ProductName ?? "";
                        info["fileDescription"] = fvi.FileDescription ?? "";
                        info["fileVersion"] = fvi.FileVersion ?? "";
                        info["companyName"] = fvi.CompanyName ?? "";
                    }
                    catch { }
                }
            }

            return info;
        }

        private class MsixAppEntry
        {
            public string PackageId;
            public string PackageFamilyName;
            public string AppId;
            public string AppUserModelId;
            public string DisplayName;
            public string ProcessName;
            public string ExePath;
            public string IconPngPath;
        }

        private static object msixCatalogLock = new object();
        private static long msixCatalogLoadedTick = 0;
        private static List<MsixAppEntry> msixAppsList = new List<MsixAppEntry>();
        private static Dictionary<string, MsixAppEntry> msixAppsByProcName = new Dictionary<string, MsixAppEntry>(StringComparer.OrdinalIgnoreCase);

        private static string ResolveBestMsixLogoPng(string pkgRoot, string relLogoPath)
        {
            if (string.IsNullOrEmpty(pkgRoot) || !Directory.Exists(pkgRoot)) return "";
            try
            {
                string assetsDir = Path.Combine(pkgRoot, "Assets");
                string stem = "";
                if (!string.IsNullOrEmpty(relLogoPath))
                {
                    string fullLogo = Path.Combine(pkgRoot, relLogoPath.Replace('/', '\\'));
                    if (File.Exists(fullLogo)) return fullLogo;
                    string dir = Path.GetDirectoryName(fullLogo);
                    if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir)) assetsDir = dir;
                    stem = Path.GetFileNameWithoutExtension(fullLogo);
                }

                if (!Directory.Exists(assetsDir)) return "";
                string[] allPngs = Directory.GetFiles(assetsDir, "*.png", SearchOption.TopDirectoryOnly);
                if (allPngs.Length == 0) return "";

                string bestFile = "";
                int bestScore = -999;
                foreach (var f in allPngs)
                {
                    string fn = Path.GetFileName(f).ToLowerInvariant();
                    if (fn.Contains("contrast-black") || fn.Contains("contrast-white") || fn.Contains("wide") || fn.Contains("splash") || fn.Contains("badge"))
                        continue;

                    int score = 0;
                    if (!string.IsNullOrEmpty(stem) && fn.StartsWith(stem.ToLowerInvariant())) score += 50;
                    else if (fn.StartsWith("applist") || fn.StartsWith("square44x44logo") || fn.StartsWith("logo")) score += 30;
                    else if (fn.StartsWith("square150x150logo") || fn.StartsWith("storelogo")) score += 15;

                    if (fn.Contains("targetsize-256")) score += 45;
                    else if (fn.Contains("targetsize-96") || fn.Contains("targetsize-80") || fn.Contains("targetsize-72")) score += 40;
                    else if (fn.Contains("targetsize-64") || fn.Contains("targetsize-48")) score += 32;
                    else if (fn.Contains("scale-200") || fn.Contains("scale-400")) score += 28;
                    else if (fn.Contains("scale-100")) score += 18;

                    if (fn.Contains("altform-unplated")) score += 8;
                    if (fn.Contains("altform-lightunplated")) score -= 6;

                    if (score > bestScore)
                    {
                        bestScore = score;
                        bestFile = f;
                    }
                }
                return bestFile;
            }
            catch { return ""; }
        }

        private static void EnsureMsixCatalogLoaded()
        {
            long nowTick = Environment.TickCount;
            lock (msixCatalogLock)
            {
                if (msixAppsList.Count > 0 && Math.Abs(nowTick - msixCatalogLoadedTick) < 60000)
                    return;
            }

            var list = new List<MsixAppEntry>();
            var byProc = new Dictionary<string, MsixAppEntry>(StringComparer.OrdinalIgnoreCase);

            try
            {
                using (var userRoot = OpenInteractiveUserRegistryRoot())
                using (var repoKey = userRoot.OpenSubKey(@"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages"))
                {
                    if (repoKey != null)
                    {
                        string[] skipPrefixes = new[]
                        {
                            "Microsoft.NET.", "Microsoft.UI.", "Microsoft.VCLibs.", "Microsoft.WindowsAppRuntime.",
                            "Microsoft.DirectX", "Microsoft.Services.", "Microsoft.Advertising.",
                            "Microsoft.ApplicationCompatibility", "Microsoft.AV1", "Microsoft.HEIF",
                            "Microsoft.HEVC", "Microsoft.MPEG2", "Microsoft.RawImage", "Microsoft.VP9",
                            "Microsoft.WebMedia", "Microsoft.Webp", "Microsoft.WinAppRuntime",
                            "MicrosoftWindows.Client", "MicrosoftWindows.UndockedDevKit",
                            "Microsoft.DesktopAppInstaller", "Microsoft.StorePurchaseApp",
                            "Microsoft.Windows.Photos", "Microsoft.WindowsTerminal", "Microsoft.SecHealthUI",
                            "Microsoft.Xbox", "Microsoft.GamingServices", "Microsoft.Edge", "Microsoft.Bing"
                        };

                        foreach (var pkgName in repoKey.GetSubKeyNames())
                        {
                            bool skip = false;
                            foreach (var sp in skipPrefixes)
                            {
                                if (pkgName.StartsWith(sp, StringComparison.OrdinalIgnoreCase))
                                {
                                    skip = true;
                                    break;
                                }
                            }
                            if (skip) continue;

                            try
                            {
                                using (var pKey = repoKey.OpenSubKey(pkgName))
                                {
                                    if (pKey == null) continue;
                                    string rootFolder = Convert.ToString(pKey.GetValue("PackageRootFolder") ?? "").Trim();
                                    if (string.IsNullOrEmpty(rootFolder) || !Directory.Exists(rootFolder)) continue;
                                    if (rootFolder.IndexOf(@"\Windows\SystemApps\", StringComparison.OrdinalIgnoreCase) >= 0) continue;

                                    string manifestPath = Path.Combine(rootFolder, "AppxManifest.xml");
                                    if (!File.Exists(manifestPath)) continue;

                                    string xml = File.ReadAllText(manifestPath);
                                    var appMatch = System.Text.RegularExpressions.Regex.Match(
                                        xml,
                                        @"<Application\b[^>]*>",
                                        System.Text.RegularExpressions.RegexOptions.IgnoreCase
                                    );
                                    if (!appMatch.Success) continue;

                                    string appTag = appMatch.Value;
                                    string appId = "App";
                                    var idM = System.Text.RegularExpressions.Regex.Match(appTag, @"\bId\s*=\s*""([^""]+)""", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                                    if (idM.Success) appId = idM.Groups[1].Value.Trim();

                                    var exeM = System.Text.RegularExpressions.Regex.Match(appTag, @"\bExecutable\s*=\s*""([^""]+)""", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                                    if (!exeM.Success) continue;
                                    string relExe = exeM.Groups[1].Value.Trim();

                                    var veMatch = System.Text.RegularExpressions.Regex.Match(
                                        xml,
                                        @"<(?:uap:)?VisualElements\b[^>]*>",
                                        System.Text.RegularExpressions.RegexOptions.IgnoreCase
                                    );
                                    if (!veMatch.Success) continue;
                                    string veTag = veMatch.Value;

                                    var listEntryM = System.Text.RegularExpressions.Regex.Match(veTag, @"\bAppListEntry\s*=\s*""([^""]+)""", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                                    if (listEntryM.Success && listEntryM.Groups[1].Value.Equals("none", StringComparison.OrdinalIgnoreCase))
                                        continue;

                                    string dispName = "";
                                    var dispM = System.Text.RegularExpressions.Regex.Match(veTag, @"\bDisplayName\s*=\s*""([^""]+)""", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                                    if (dispM.Success) dispName = dispM.Groups[1].Value.Trim();

                                    if (string.IsNullOrEmpty(dispName) || dispName.StartsWith("ms-resource:", StringComparison.OrdinalIgnoreCase))
                                    {
                                        var propDispM = System.Text.RegularExpressions.Regex.Match(xml, @"<DisplayName>([^<]+)</DisplayName>", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                                        if (propDispM.Success) dispName = propDispM.Groups[1].Value.Trim();
                                    }

                                    if (string.IsNullOrEmpty(dispName) || dispName.StartsWith("ms-resource:", StringComparison.OrdinalIgnoreCase))
                                        continue;

                                    string relLogo = "";
                                    var logo44M = System.Text.RegularExpressions.Regex.Match(veTag, @"\bSquare44x44Logo\s*=\s*""([^""]+)""", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                                    if (logo44M.Success) relLogo = logo44M.Groups[1].Value.Trim();
                                    if (string.IsNullOrEmpty(relLogo))
                                    {
                                        var logo150M = System.Text.RegularExpressions.Regex.Match(veTag, @"\bSquare150x150Logo\s*=\s*""([^""]+)""", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                                        if (logo150M.Success) relLogo = logo150M.Groups[1].Value.Trim();
                                    }

                                    string[] pkgParts = pkgName.Split('_');
                                    if (pkgParts.Length < 2) continue;
                                    string familyName = pkgParts[0] + "_" + pkgParts[pkgParts.Length - 1];
                                    string aumid = familyName + "!" + appId;
                                    string fullExe = Path.Combine(rootFolder, relExe.Replace('/', '\\'));
                                    string procName = Path.GetFileNameWithoutExtension(fullExe);
                                    string bestPng = ResolveBestMsixLogoPng(rootFolder, relLogo);

                                    var entry = new MsixAppEntry
                                    {
                                        PackageId = pkgName,
                                        PackageFamilyName = familyName,
                                        AppId = appId,
                                        AppUserModelId = aumid,
                                        DisplayName = CleanAppDisplayName(dispName),
                                        ProcessName = procName,
                                        ExePath = fullExe,
                                        IconPngPath = bestPng
                                    };
                                    list.Add(entry);
                                    if (!string.IsNullOrEmpty(procName) && !byProc.ContainsKey(procName))
                                    {
                                        byProc[procName] = entry;
                                    }
                                    if (!string.IsNullOrEmpty(entry.DisplayName) && !byProc.ContainsKey(entry.DisplayName))
                                    {
                                        byProc[entry.DisplayName] = entry;
                                    }
                                }
                            }
                            catch { }
                        }
                    }
                }
            }
            catch { }

            lock (msixCatalogLock)
            {
                msixAppsList = list;
                msixAppsByProcName = byProc;
                msixCatalogLoadedTick = nowTick;
            }
        }

        private static object ExecuteQuickItemCommand(Dictionary<string, object> args)
        {
            string targetPath = args.ContainsKey("targetPath") ? Convert.ToString(args["targetPath"]).Trim() : "";
            string openWithMode = args.ContainsKey("openWithMode") ? Convert.ToString(args["openWithMode"]).Trim() : "default";
            string openWithPath = args.ContainsKey("openWithPath") ? Convert.ToString(args["openWithPath"]).Trim() : "";
            string extraArgs = args.ContainsKey("arguments") ? Convert.ToString(args["arguments"]).Trim() : "";
            string workingDir = args.ContainsKey("workingDirectory") ? Convert.ToString(args["workingDirectory"]).Trim() : "";
            string windowStyle = args.ContainsKey("windowStyle") ? Convert.ToString(args["windowStyle"]).Trim().ToLowerInvariant() : "normal";
            bool runAsAdmin = args.ContainsKey("runAsAdmin") && Convert.ToBoolean(args["runAsAdmin"]);
            string priority = args.ContainsKey("priority") ? Convert.ToString(args["priority"]).Trim().ToLowerInvariant() : "normal";
            string ifRunning = args.ContainsKey("ifRunning") ? Convert.ToString(args["ifRunning"]).Trim().ToLowerInvariant() : "new";
            int monitorIndex = args.ContainsKey("monitorIndex") ? Convert.ToInt32(args["monitorIndex"]) : -1;
            string zone = args.ContainsKey("zone") ? Convert.ToString(args["zone"]).Trim().ToLowerInvariant() : "none";
            bool alwaysOnTop = args.ContainsKey("alwaysOnTop") && Convert.ToBoolean(args["alwaysOnTop"]);
            string explicitProcName = args.ContainsKey("processName") ? Convert.ToString(args["processName"]).Trim() : "";

            if (string.IsNullOrEmpty(targetPath))
                return new { ok = false, error = "Hedef yol boş" };

            // Automatic Riot Games & MSIX launcher normalization (even for previously saved items)
            string riotClientServices = @"C:\Riot Games\Riot Client\RiotClientServices.exe";
            if (File.Exists(riotClientServices))
            {
                if (targetPath.EndsWith(@"\VALORANT\live\VALORANT.exe", StringComparison.OrdinalIgnoreCase) ||
                    targetPath.EndsWith(@"VALORANT-Win64-Shipping.exe", StringComparison.OrdinalIgnoreCase) ||
                    (targetPath.EndsWith(@"\VALORANT.exe", StringComparison.OrdinalIgnoreCase) && string.IsNullOrEmpty(extraArgs)))
                {
                    targetPath = riotClientServices;
                    extraArgs = "--launch-product=valorant --launch-patchline=live";
                    if (string.IsNullOrEmpty(explicitProcName)) explicitProcName = "VALORANT";
                }
                else if (targetPath.EndsWith(@"\LeagueClient.exe", StringComparison.OrdinalIgnoreCase) && string.IsNullOrEmpty(extraArgs))
                {
                    targetPath = riotClientServices;
                    extraArgs = "--launch-product=league_of_legends --launch-patchline=live";
                    if (string.IsNullOrEmpty(explicitProcName)) explicitProcName = "LeagueClientUx";
                }
            }

            if (targetPath.EndsWith("WhatsApp.Root.exe", StringComparison.OrdinalIgnoreCase))
            {
                EnsureMsixCatalogLoaded();
                lock (msixCatalogLock)
                {
                    if (msixAppsByProcName.ContainsKey("WhatsApp.Root"))
                    {
                        var wa = msixAppsByProcName["WhatsApp.Root"];
                        targetPath = "explorer.exe";
                        extraArgs = @"shell:AppsFolder\" + wa.AppUserModelId;
                        explicitProcName = "WhatsApp";
                    }
                }
            }

            // Determine process name candidate for focus/restart/snapping
            string procCandidate = explicitProcName;
            if (string.IsNullOrEmpty(procCandidate))
            {
                if (openWithMode != "default" && !string.IsNullOrEmpty(openWithPath))
                {
                    procCandidate = Path.GetFileNameWithoutExtension(openWithPath);
                }
                else if (targetPath.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) &&
                         !targetPath.EndsWith("explorer.exe", StringComparison.OrdinalIgnoreCase) &&
                         !targetPath.EndsWith("RiotClientServices.exe", StringComparison.OrdinalIgnoreCase))
                {
                    procCandidate = Path.GetFileNameWithoutExtension(targetPath);
                }
                else if (Directory.Exists(targetPath))
                {
                    procCandidate = "explorer";
                }
                else if (File.Exists(targetPath))
                {
                    string dName, dExe;
                    QueryExtensionAssociation(Path.GetExtension(targetPath), out dName, out dExe);
                    if (!string.IsNullOrEmpty(dExe))
                        procCandidate = Path.GetFileNameWithoutExtension(dExe);
                }
            }

            // Handle ifRunning policy ("focus" or "restart")
            if (!string.IsNullOrEmpty(procCandidate) && !procCandidate.Equals("explorer", StringComparison.OrdinalIgnoreCase))
            {
                if (ifRunning == "focus")
                {
                    var openWins = GetOpenWindows();
                    foreach (var w in openWins)
                    {
                        string pName = Convert.ToString(w["processName"]);
                        string rawP = w.ContainsKey("rawProcessName") ? Convert.ToString(w["rawProcessName"]) : "";
                        if (pName.Equals(procCandidate, StringComparison.OrdinalIgnoreCase) ||
                            (!string.IsNullOrEmpty(rawP) && rawP.Equals(procCandidate, StringComparison.OrdinalIgnoreCase)))
                        {
                            long existingHwnd = Convert.ToInt64(w["hwnd"]);
                            ApplyPostLaunchWindowRules(existingHwnd, procCandidate, monitorIndex, zone, windowStyle, alwaysOnTop);
                            return new { ok = true, mode = "reused_existing", hwnd = existingHwnd, processName = procCandidate };
                        }
                    }
                }
                else if (ifRunning == "restart")
                {
                    try
                    {
                        foreach (var p in Process.GetProcessesByName(procCandidate))
                        {
                            try { p.Kill(); p.WaitForExit(1000); } catch { }
                        }
                    }
                    catch { }
                }
            }

            // Snapshot existing windows before launch so we can detect newly created window asynchronously
            var beforeHwnds = new HashSet<long>();
            try
            {
                foreach (var w in GetOpenWindows())
                {
                    beforeHwnds.Add(Convert.ToInt64(w["hwnd"]));
                }
            }
            catch { }

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.UseShellExecute = true;

            if (targetPath.StartsWith(@"shell:AppsFolder\", StringComparison.OrdinalIgnoreCase))
            {
                psi.FileName = "explorer.exe";
                psi.Arguments = targetPath;
            }
            else if (openWithMode != "default" && !string.IsNullOrEmpty(openWithPath))
            {
                psi.FileName = openWithPath;
                string quotedTarget = "\"" + targetPath + "\"";
                psi.Arguments = string.IsNullOrEmpty(extraArgs) ? quotedTarget : (quotedTarget + " " + extraArgs);
            }
            else if (Directory.Exists(targetPath))
            {
                psi.FileName = "explorer.exe";
                psi.Arguments = "\"" + targetPath + "\"";
            }
            else
            {
                psi.FileName = targetPath;
                if (!string.IsNullOrEmpty(extraArgs))
                    psi.Arguments = extraArgs;
            }

            if (!string.IsNullOrEmpty(workingDir) && Directory.Exists(workingDir))
            {
                psi.WorkingDirectory = workingDir;
            }
            else if (File.Exists(targetPath) && !targetPath.EndsWith("explorer.exe", StringComparison.OrdinalIgnoreCase))
            {
                try { psi.WorkingDirectory = Path.GetDirectoryName(targetPath); } catch { }
            }
            else if (Directory.Exists(targetPath))
            {
                psi.WorkingDirectory = targetPath;
            }

            if (windowStyle == "maximized") psi.WindowStyle = ProcessWindowStyle.Maximized;
            else if (windowStyle == "minimized") psi.WindowStyle = ProcessWindowStyle.Minimized;
            else if (windowStyle == "hidden") psi.WindowStyle = ProcessWindowStyle.Hidden;
            else psi.WindowStyle = ProcessWindowStyle.Normal;

            if (runAsAdmin)
            {
                psi.Verb = "runas";
            }

            Process startedProc = null;
            int userSessionPid = 0;
            try
            {
                if (!runAsAdmin && IsRunningAsSystemAccount() && TryStartProcessInActiveUserSession(psi.FileName, psi.Arguments, psi.WorkingDirectory, windowStyle, out userSessionPid))
                {
                    if (userSessionPid > 0)
                    {
                        try { startedProc = Process.GetProcessById(userSessionPid); } catch { }
                    }
                }
                else
                {
                    startedProc = Process.Start(psi);
                }
            }
            catch (Exception ex)
            {
                return new { ok = false, error = ex.Message };
            }

            // Apply CPU Priority if requested
            if (startedProc != null && priority != "normal")
            {
                try
                {
                    if (priority == "high") startedProc.PriorityClass = ProcessPriorityClass.High;
                    else if (priority == "above_normal") startedProc.PriorityClass = ProcessPriorityClass.AboveNormal;
                    else if (priority == "below_normal") startedProc.PriorityClass = ProcessPriorityClass.BelowNormal;
                }
                catch { }
            }

            int startedPid = 0;
            try { if (startedProc != null) startedPid = startedProc.Id; } catch { }

            // Position newly opened window on a background worker so launching apps/games returns in <30ms
            if (monitorIndex >= 0 || (zone != "none" && !string.IsNullOrEmpty(zone)) || alwaysOnTop || windowStyle == "maximized")
            {
                ThreadPool.QueueUserWorkItem(_ =>
                {
                    try
                    {
                        long targetHwnd = 0;
                        int attempts = 0;
                        while (attempts < 22 && targetHwnd == 0)
                        {
                            Thread.Sleep(250);
                            attempts++;
                            var currentWins = GetOpenWindows();
                            foreach (var w in currentWins)
                            {
                                long h = Convert.ToInt64(w["hwnd"]);
                                string pName = Convert.ToString(w["processName"]);
                                string rawP = w.ContainsKey("rawProcessName") ? Convert.ToString(w["rawProcessName"]) : "";
                                if (!beforeHwnds.Contains(h))
                                {
                                    if (string.IsNullOrEmpty(procCandidate) ||
                                        pName.Equals(procCandidate, StringComparison.OrdinalIgnoreCase) ||
                                        (!string.IsNullOrEmpty(rawP) && rawP.Equals(procCandidate, StringComparison.OrdinalIgnoreCase)) ||
                                        (startedPid != 0 && Convert.ToInt32(w["pid"]) == startedPid))
                                    {
                                        targetHwnd = h;
                                        break;
                                    }
                                }
                            }
                            if (targetHwnd == 0 && !string.IsNullOrEmpty(procCandidate) && attempts >= 5)
                            {
                                foreach (var w in currentWins)
                                {
                                    string pName = Convert.ToString(w["processName"]);
                                    string rawP = w.ContainsKey("rawProcessName") ? Convert.ToString(w["rawProcessName"]) : "";
                                    if (pName.Equals(procCandidate, StringComparison.OrdinalIgnoreCase) ||
                                        (!string.IsNullOrEmpty(rawP) && rawP.Equals(procCandidate, StringComparison.OrdinalIgnoreCase)))
                                    {
                                        targetHwnd = Convert.ToInt64(w["hwnd"]);
                                        break;
                                    }
                                }
                            }
                        }

                        if (targetHwnd != 0)
                        {
                            ApplyPostLaunchWindowRules(targetHwnd, procCandidate, monitorIndex, zone, windowStyle, alwaysOnTop);
                        }
                    }
                    catch { }
                });
            }

            return new
            {
                ok = true,
                targetPath = targetPath,
                openWithPath = openWithPath,
                hwnd = 0,
                processName = procCandidate
            };
        }

        private static void ApplyPostLaunchWindowRules(long hwndLong, string procCandidate, int monitorIndex, string zone, string windowStyle, bool alwaysOnTop)
        {
            IntPtr hWnd = new IntPtr(hwndLong);
            if (hWnd == IntPtr.Zero) return;

            bool hasExplicitZone = !string.IsNullOrEmpty(zone) && zone != "none" && zone != "custom" && zone != "default";
            if (hasExplicitZone || windowStyle == "maximized")
            {
                int targetMon = monitorIndex >= 0 ? monitorIndex : 0;
                double zx = 0.0, zy = 0.0, zw = 1.0, zh = 1.0;
                string zState = windowStyle == "maximized" ? "maximized" : "normal";
                if (hasExplicitZone)
                {
                    ResolveZoneRect(zone, out zx, out zy, out zw, out zh, out zState);
                }

                var snapArgs = new Dictionary<string, object>
                {
                    { "hwnd", hwndLong },
                    { "processName", procCandidate ?? "" },
                    { "monitorIndex", targetMon },
                    { "state", zState },
                    { "x", zx },
                    { "y", zy },
                    { "w", zw },
                    { "h", zh }
                };
                SnapWindowCommand(snapArgs);
            }
            else if (monitorIndex >= 0 && windowStyle != "minimized")
            {
                // Move to target monitor while preserving the application's native default window dimensions!
                var monitors = GetMonitorsList();
                if (monitors.Count > 0)
                {
                    int mIdx = monitorIndex < monitors.Count ? monitorIndex : 0;
                    var mon = monitors[mIdx];
                    RECT r;
                    if (GetWindowRect(hWnd, out r))
                    {
                        int w = Math.Max(200, r.Right - r.Left);
                        int h = Math.Max(120, r.Bottom - r.Top);
                        int nx = mon.workX + Math.Max(0, (mon.workWidth - w) / 2);
                        int ny = mon.workY + Math.Max(0, (mon.workHeight - h) / 2);
                        SetWindowPos(hWnd, HWND_TOP, nx, ny, w, h, SWP_NOSIZE | SWP_SHOWWINDOW);
                    }
                }
                ForceForeground(hWnd);
            }
            else if (windowStyle == "minimized")
            {
                ShowWindow(hWnd, SW_MINIMIZE);
            }
            else
            {
                ForceForeground(hWnd);
            }

            if (alwaysOnTop)
            {
                SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            }
        }

        private static string CleanAppDisplayName(string rawName)
        {
            if (string.IsNullOrWhiteSpace(rawName)) return "";
            string s = rawName.Replace("\0", "").Trim();
            string[] stripSuffixes = new[]
            {
                " (User)",
                " (x64 en-US)",
                " (x64)",
                " (x86)",
                " (64-bit)",
                " (64 bit)",
                " (32-bit)",
                " (32 bit)",
                " - tr-tr"
            };
            foreach (var suf in stripSuffixes)
            {
                if (s.EndsWith(suf, StringComparison.OrdinalIgnoreCase))
                    s = s.Substring(0, s.Length - suf.Length).Trim();
            }
            int forIdx = s.IndexOf(" for ", StringComparison.OrdinalIgnoreCase);
            if (forIdx > 4 && s.StartsWith("Roblox ", StringComparison.OrdinalIgnoreCase))
            {
                s = s.Substring(0, forIdx).Trim();
            }
            // Strip trailing version numbers like "SteelSeries GG 122.0.0", "WinRAR 7.23", "Postman x64 12.23.7"
            s = System.Text.RegularExpressions.Regex.Replace(s, @"\s+(?:x64\s+|x86\s+)?v?\d+(?:\.\d+){1,4}$", "", System.Text.RegularExpressions.RegexOptions.IgnoreCase).Trim();
            if (s.Equals("Microsoft Visual Studio Code", StringComparison.OrdinalIgnoreCase))
                s = "Visual Studio Code";
            return s;
        }

        private static bool IsNoisyShortcutOrExe(string name, string targetPath)
        {
            if (string.IsNullOrWhiteSpace(name)) return true;
            string n = name.Replace("\0", "").Trim();
            if (n.Length <= 1) return true;

            string[] badWords = new[]
            {
                "uninstall", "kaldır", "unins000", "readme", "help", "yardım", "website",
                "web sitesi", "manual", "documentation", "license", "release notes",
                "diagnostic", "crashpad", "error reporter", "updater", "auto-update",
                "node.js command prompt", "install additional tools", "redistributable",
                "vcredist", "vc_redist", "desktop runtime", ".net runtime", ".net sdk",
                "openjdk", "clr types", "gameinput", "compatibility fix", "sdk addon",
                "frameview sdk", "physx", "grafik sürücüsü", "graphics driver", "hd ses sürücüsü",
                "audio driver", "ethernet controller", "controller driver", "maintenance service",
                "armoury crate service", "rog live service", "xbox service", "epic online services",
                "riot vanguard", "faceit anti-cheat", "remote desktop host", "meeting add-in",
                "visual studio installer", "office clicktorun", "office ev ve öğrenci",
                "ekran okuyucusu", "ekran klavyesi", "büyüteç", "ses kaydedicisi", "adım kaydedicisi",
                "karakter eşlem", "disk temizleme", "birleştir ve iyileştir", "sistem bilgisi",
                "sistem yapılandırması", "kaynak izleyicisi", "performans izleyicisi",
                "olay görüntüleyicisi", "kayıt defteri düzenleyicisi", "komut istemi",
                "windows powershell", "git bash", "git cmd", "git gui", "idle (python",
                "python manuals", "python module docs", "odbc data sources", "bileşen hizmetleri",
                "bilgisayar yönetimi", "hizmetler", "kurtarma sürücüsü", "görev zamanlayıcı",
                "windows bellek tanılama", "windows defender güvenlik duvarı", "wordpad",
                "uzağa bağlantı", "poppler", "rokit", "cloudflared", "bun",
                "administrative tools", "application verifier", "asus framework",
                "debuggable package manager", "developer command prompt", "gpuview",
                "konsol rar", "office dil tercihleri", "openal", "pydoc", "riot istemcisi",
                "sample desktop apps", "sample uwp apps", "tools for desktop apps",
                "tools for uwp apps", "windows app cert kit", "windows performance",
                "windows software development kit", "zen private browsing",
                "blend for visual studio", "file explorer"
            };
            foreach (var bw in badWords)
            {
                if (n.IndexOf(bw, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            }
            if (n.StartsWith("Python 3.", StringComparison.OrdinalIgnoreCase) ||
                n.Equals("Git", StringComparison.OrdinalIgnoreCase) ||
                n.Equals("Node.js", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
            if (!string.IsNullOrEmpty(targetPath))
            {
                string fn = Path.GetFileName(targetPath.Replace('/', '\\'));
                if (fn.StartsWith("unins", StringComparison.OrdinalIgnoreCase) ||
                    fn.Equals("uninstall.exe", StringComparison.OrdinalIgnoreCase) ||
                    fn.Equals("uninstaller.exe", StringComparison.OrdinalIgnoreCase) ||
                    fn.Equals("msiexec.exe", StringComparison.OrdinalIgnoreCase) ||
                    fn.Equals("rundll32.exe", StringComparison.OrdinalIgnoreCase) ||
                    fn.Equals("setup.exe", StringComparison.OrdinalIgnoreCase) ||
                    fn.IndexOf("setup", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    fn.Equals("DXSETUP.exe", StringComparison.OrdinalIgnoreCase) ||
                    fn.Equals("oalinst.exe", StringComparison.OrdinalIgnoreCase) ||
                    fn.Equals("NVI2.dll", StringComparison.OrdinalIgnoreCase) ||
                    fn.Equals("OfficeClickToRun.exe", StringComparison.OrdinalIgnoreCase) ||
                    fn.Equals("ArmouryCrate.Service.exe", StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            return false;
        }

        private static string FindPrimaryExeInDirectory(string dirPath, string preferredName)
        {
            if (string.IsNullOrEmpty(dirPath)) return "";
            string cleanDir = Environment.ExpandEnvironmentVariables(dirPath.Trim().Trim('"')).Replace('/', '\\');
            if (!Directory.Exists(cleanDir)) return "";

            try
            {
                // 1. Check Squirrel Update.exe pattern (Discord, FACEIT, Postman, Proton Pass)
                string updateExe = Path.Combine(cleanDir, "Update.exe");
                if (File.Exists(updateExe))
                {
                    var appDirs = Directory.GetDirectories(cleanDir, "app-*");
                    Array.Sort(appDirs, StringComparer.OrdinalIgnoreCase);
                    for (int i = appDirs.Length - 1; i >= 0; i--)
                    {
                        foreach (var exe in Directory.GetFiles(appDirs[i], "*.exe"))
                        {
                            string fn = Path.GetFileName(exe);
                            if (!fn.Equals("Update.exe", StringComparison.OrdinalIgnoreCase) &&
                                !fn.StartsWith("squirrel", StringComparison.OrdinalIgnoreCase) &&
                                fn.IndexOf("crashpad", StringComparison.OrdinalIgnoreCase) < 0 &&
                                fn.IndexOf("helper", StringComparison.OrdinalIgnoreCase) < 0)
                            {
                                return exe;
                            }
                        }
                    }
                }

                // 2. Check top-level and 1-level subdirectory executables
                var candidateFiles = new List<string>();
                try { candidateFiles.AddRange(Directory.GetFiles(cleanDir, "*.exe")); } catch { }
                try
                {
                    foreach (var sub in Directory.GetDirectories(cleanDir))
                    {
                        string subName = Path.GetFileName(sub);
                        if (subName.Equals("uninstall", StringComparison.OrdinalIgnoreCase) ||
                            subName.Equals("redist", StringComparison.OrdinalIgnoreCase)) continue;
                        try { candidateFiles.AddRange(Directory.GetFiles(sub, "*.exe")); } catch { }
                    }
                }
                catch { }

                string cleanPref = (preferredName ?? "").Replace(" ", "").ToLowerInvariant();
                string bestMatch = "";
                long bestSize = -1;

                foreach (var f in candidateFiles)
                {
                    string fn = Path.GetFileName(f);
                    if (IsNoisyShortcutOrExe(fn, f)) continue;
                    if (fn.IndexOf("crash", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        fn.IndexOf("helper", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        fn.IndexOf("service", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        fn.IndexOf("reporter", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        fn.IndexOf("installer", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        fn.Equals("Update.exe", StringComparison.OrdinalIgnoreCase))
                        continue;

                    string stem = Path.GetFileNameWithoutExtension(f).Replace(" ", "").ToLowerInvariant();
                    if (!string.IsNullOrEmpty(cleanPref) && (stem == cleanPref || stem.Contains(cleanPref) || cleanPref.Contains(stem)))
                    {
                        return f;
                    }

                    try
                    {
                        long len = new FileInfo(f).Length;
                        if (len > bestSize)
                        {
                            bestSize = len;
                            bestMatch = f;
                        }
                    }
                    catch { }
                }

                return bestMatch;
            }
            catch { return ""; }
        }

        private static List<Dictionary<string, object>> GetInstalledApps()
        {
            var apps = new Dictionary<string, Dictionary<string, object>>(StringComparer.OrdinalIgnoreCase);
            var seenTargets = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            Action<string, string, string, string, string, string> addAppEntry = (rawName, proc, launchPath, args, iconSource, sourceKind) =>
            {
                string cleanName = CleanAppDisplayName(rawName);
                if (string.IsNullOrWhiteSpace(cleanName) || string.IsNullOrWhiteSpace(launchPath)) return;
                if (IsNoisyShortcutOrExe(cleanName, launchPath)) return;

                string normLaunch = launchPath.Trim().Trim('"').Replace('/', '\\');
                string targetDedupKey = (normLaunch + "|" + (args ?? "").Trim()).ToLowerInvariant();
                if (seenTargets.Contains(targetDedupKey) || apps.ContainsKey(cleanName))
                    return;

                int dummyIdx;
                string realIconPath = ResolveRealExeForIcon(string.IsNullOrEmpty(iconSource) ? normLaunch : iconSource, out dummyIdx);
                string iconData = GetAppIconBase64(string.IsNullOrEmpty(iconSource) ? normLaunch : iconSource);
                if (string.IsNullOrEmpty(iconData) && !string.IsNullOrEmpty(realIconPath))
                {
                    iconData = GetAppIconBase64(realIconPath);
                }
                if (string.IsNullOrEmpty(iconData) && File.Exists(normLaunch))
                {
                    iconData = GetAppIconBase64(normLaunch);
                }

                // Skip entries that have no icon at all unless they are open windows
                if (string.IsNullOrEmpty(iconData) && sourceKind != "running")
                    return;

                string cleanProc = proc;
                if (string.IsNullOrEmpty(cleanProc) && normLaunch.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                {
                    cleanProc = Path.GetFileNameWithoutExtension(normLaunch);
                }
                if (string.IsNullOrEmpty(cleanProc)) cleanProc = cleanName;

                seenTargets.Add(targetDedupKey);
                apps[cleanName] = new Dictionary<string, object>
                {
                    { "name", cleanName },
                    { "processName", cleanProc },
                    { "launchPath", normLaunch },
                    { "launchArgs", args ?? "" },
                    { "icon", iconData },
                    { "source", sourceKind }
                };
            };

            string userProfDir = GetInteractiveUserProfilePath();
            string localApp = IsRunningAsSystemAccount() ? Path.Combine(userProfDir, @"AppData\Local") : Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string appData = IsRunningAsSystemAccount() ? Path.Combine(userProfDir, @"AppData\Roaming") : Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string progFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string progFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);

            // 1. Scan Windows Registry "Installed Apps" (Yüklü Uygulamalar) first so official app names & icons take priority
            RegistryKey userRootForApps = OpenInteractiveUserRegistryRoot();
            RegistryKey[] regRoots = new[]
            {
                userRootForApps != null ? userRootForApps.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall") : null,
                Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
                Registry.LocalMachine.OpenSubKey(@"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall")
            };

            foreach (var root in regRoots)
            {
                if (root == null) continue;
                try
                {
                    foreach (var subName in root.GetSubKeyNames())
                    {
                        try
                        {
                            using (var sub = root.OpenSubKey(subName))
                            {
                                if (sub == null) continue;
                                int sysComp = 0;
                                try { sysComp = Convert.ToInt32(sub.GetValue("SystemComponent") ?? 0); } catch { }
                                if (sysComp == 1) continue;

                                string parentKey = Convert.ToString(sub.GetValue("ParentKeyName") ?? "").Trim();
                                string releaseType = Convert.ToString(sub.GetValue("ReleaseType") ?? "").Trim();
                                if (!string.IsNullOrEmpty(parentKey) ||
                                    releaseType.Equals("Security Update", StringComparison.OrdinalIgnoreCase) ||
                                    releaseType.Equals("Update", StringComparison.OrdinalIgnoreCase) ||
                                    releaseType.Equals("Hotfix", StringComparison.OrdinalIgnoreCase))
                                    continue;

                                string dispName = Convert.ToString(sub.GetValue("DisplayName") ?? "").Replace("\0", "").Trim();
                                if (string.IsNullOrEmpty(dispName)) continue;

                                string dispIcon = Convert.ToString(sub.GetValue("DisplayIcon") ?? "").Replace("\0", "").Trim();
                                string installLoc = Convert.ToString(sub.GetValue("InstallLocation") ?? "").Replace("\0", "").Trim().Trim('"');
                                if (IsNoisyShortcutOrExe(dispName, "")) continue;

                                // Case A: Steam Installed Game ("Steam App <AppId>")
                                if (subName.StartsWith("Steam App ", StringComparison.OrdinalIgnoreCase))
                                {
                                    string steamAppId = subName.Substring("Steam App ".Length).Trim();
                                    string gameExe = FindPrimaryExeInDirectory(installLoc, dispName);
                                    string steamExePath = Path.Combine(progFilesX86, "Steam", "steam.exe");
                                    string launchTarget = File.Exists(steamExePath) ? steamExePath : ("steam://rungameid/" + steamAppId);
                                    string launchArgs = File.Exists(steamExePath) ? ("-applaunch " + steamAppId) : "";
                                    string iconSrc = !string.IsNullOrEmpty(dispIcon) ? dispIcon : gameExe;
                                    string proc = !string.IsNullOrEmpty(gameExe) ? Path.GetFileNameWithoutExtension(gameExe) : dispName;
                                    addAppEntry(dispName, proc, launchTarget, launchArgs, iconSrc, "installed");
                                    continue;
                                }

                                // Case B: Squirrel / Electron Apps with Update.exe in InstallLocation (Discord, FACEIT, Postman, Proton Pass)
                                if (!string.IsNullOrEmpty(installLoc) && Directory.Exists(installLoc))
                                {
                                    string updateExe = Path.Combine(installLoc, "Update.exe");
                                    if (File.Exists(updateExe))
                                    {
                                        string innerExe = FindPrimaryExeInDirectory(installLoc, dispName);
                                        if (!string.IsNullOrEmpty(innerExe) && File.Exists(innerExe))
                                        {
                                            string exeFile = Path.GetFileName(innerExe);
                                            string proc = Path.GetFileNameWithoutExtension(innerExe);
                                            string appIco = Path.Combine(installLoc, "app.ico");
                                            string iconSrc = File.Exists(appIco) ? appIco : innerExe;
                                            addAppEntry(dispName, proc, updateExe, "--processStart " + exeFile, iconSrc, "installed");
                                            continue;
                                        }
                                    }
                                }

                                // Case C: Riot Games (VALORANT, League of Legends, Teamfight Tactics, Riot Client)
                                if (subName.StartsWith("Riot Game ", StringComparison.OrdinalIgnoreCase) ||
                                    (!string.IsNullOrEmpty(installLoc) && installLoc.IndexOf("Riot Games", StringComparison.OrdinalIgnoreCase) >= 0))
                                {
                                    string normLoc = (installLoc ?? "").Replace('/', '\\');
                                    string riotExe = !string.IsNullOrEmpty(normLoc) ? FindPrimaryExeInDirectory(normLoc, dispName) : "";
                                    string riotClientExe = @"C:\Riot Games\Riot Client\RiotClientServices.exe";
                                    string uninstStr = Convert.ToString(sub.GetValue("UninstallString") ?? "").Trim();

                                    string launchTarget = File.Exists(riotClientExe) ? riotClientExe : riotExe;
                                    string launchArgs = "";
                                    if (dispName.Equals("Riot Client", StringComparison.OrdinalIgnoreCase))
                                    {
                                        launchArgs = "";
                                    }
                                    else if (uninstStr.IndexOf("--uninstall-product=", StringComparison.OrdinalIgnoreCase) >= 0)
                                    {
                                        int idxOpt = uninstStr.IndexOf("--uninstall-product=", StringComparison.OrdinalIgnoreCase);
                                        launchArgs = uninstStr
                                            .Substring(idxOpt)
                                            .Replace("--uninstall-product=", "--launch-product=")
                                            .Replace("--uninstall-patchline=", "--launch-patchline=")
                                            .Trim();
                                    }
                                    else if (dispName.IndexOf("VALORANT", StringComparison.OrdinalIgnoreCase) >= 0)
                                    {
                                        launchArgs = "--launch-product=valorant --launch-patchline=live";
                                    }
                                    else if (dispName.IndexOf("League of Legends", StringComparison.OrdinalIgnoreCase) >= 0)
                                    {
                                        launchArgs = "--launch-product=league_of_legends --launch-patchline=live";
                                    }
                                    else if (dispName.IndexOf("Teamfight Tactics", StringComparison.OrdinalIgnoreCase) >= 0)
                                    {
                                        launchArgs = "--launch-product=bacon --launch-patchline=live";
                                    }

                                    if (!string.IsNullOrEmpty(launchTarget))
                                    {
                                        string proc = !string.IsNullOrEmpty(riotExe) ? Path.GetFileNameWithoutExtension(riotExe) : dispName;
                                        string iconSrc = !string.IsNullOrEmpty(dispIcon) ? dispIcon : (!string.IsNullOrEmpty(riotExe) ? riotExe : launchTarget);
                                        addAppEntry(dispName, proc, launchTarget, launchArgs, iconSrc, "installed");
                                        continue;
                                    }
                                }

                                // Case D: Roblox Player / Studio
                                if (dispName.StartsWith("Roblox ", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrEmpty(installLoc) && Directory.Exists(installLoc))
                                {
                                    string betaExe = Path.Combine(installLoc, dispName.IndexOf("Studio", StringComparison.OrdinalIgnoreCase) >= 0 ? "RobloxStudioBeta.exe" : "RobloxPlayerBeta.exe");
                                    if (File.Exists(betaExe))
                                    {
                                        addAppEntry(dispName, Path.GetFileNameWithoutExtension(betaExe), betaExe, "", betaExe, "installed");
                                        continue;
                                    }
                                }

                                // Case E: Standard DisplayIcon or InstallLocation executable
                                int iconIdx;
                                string resolvedIconPath = ResolveRealExeForIcon(dispIcon, out iconIdx);
                                string launchExe = "";
                                if (!string.IsNullOrEmpty(resolvedIconPath) &&
                                    resolvedIconPath.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) &&
                                    File.Exists(resolvedIconPath) &&
                                    !IsNoisyShortcutOrExe(dispName, resolvedIconPath))
                                {
                                    launchExe = resolvedIconPath;
                                }
                                else if (!string.IsNullOrEmpty(installLoc) && Directory.Exists(installLoc))
                                {
                                    launchExe = FindPrimaryExeInDirectory(installLoc, dispName);
                                }

                                if (!string.IsNullOrEmpty(launchExe) && File.Exists(launchExe))
                                {
                                    string proc = Path.GetFileNameWithoutExtension(launchExe);
                                    string iconSrc = !string.IsNullOrEmpty(dispIcon) ? dispIcon : launchExe;
                                    addAppEntry(dispName, proc, launchExe, "", iconSrc, "installed");
                                }
                            }
                        }
                        catch { }
                    }
                }
                catch { }
                finally
                {
                    try { root.Close(); } catch { }
                }
            }

            // 1.5. Scan Windows MSIX / Microsoft Store Installed Apps (WhatsApp, Claude, ChatGPT, Minecraft Launcher, Teams, Armoury Crate)
            EnsureMsixCatalogLoaded();
            List<MsixAppEntry> msixSnapshot;
            lock (msixCatalogLock)
            {
                msixSnapshot = new List<MsixAppEntry>(msixAppsList);
            }
            foreach (var m in msixSnapshot)
            {
                if (string.IsNullOrEmpty(m.DisplayName) || string.IsNullOrEmpty(m.AppUserModelId)) continue;
                string iconSrc = !string.IsNullOrEmpty(m.IconPngPath) && File.Exists(m.IconPngPath) ? m.IconPngPath : m.ExePath;
                addAppEntry(
                    m.DisplayName,
                    m.DisplayName,
                    "explorer.exe",
                    @"shell:AppsFolder\" + m.AppUserModelId,
                    iconSrc,
                    "installed"
                );
            }

            // 2. Check core known desktop applications (Chrome, Edge, Brave, Steam, OBS, Explorer, Task Manager)
            var knownCandidates = new[]
            {
                new { Name = "Discord", Proc = "Discord", Path = Path.Combine(localApp, "Discord", "Update.exe"), Args = "--processStart Discord.exe" },
                new { Name = "Spotify", Proc = "Spotify", Path = Path.Combine(appData, "Spotify", "Spotify.exe"), Args = "" },
                new { Name = "Google Chrome", Proc = "chrome", Path = Path.Combine(progFiles, "Google", "Chrome", "Application", "chrome.exe"), Args = "" },
                new { Name = "Microsoft Edge", Proc = "msedge", Path = Path.Combine(progFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"), Args = "" },
                new { Name = "Brave Browser", Proc = "brave", Path = Path.Combine(progFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"), Args = "" },
                new { Name = "Steam", Proc = "steam", Path = Path.Combine(progFilesX86, "Steam", "steam.exe"), Args = "" },
                new { Name = "Visual Studio Code", Proc = "Code", Path = Path.Combine(localApp, "Programs", "Microsoft VS Code", "Code.exe"), Args = "" },
                new { Name = "OBS Studio", Proc = "obs64", Path = Path.Combine(progFiles, "obs-studio", "bin", "64bit", "obs64.exe"), Args = "" },
                new { Name = "Windows Gezgini", Proc = "explorer", Path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe"), Args = "" },
                new { Name = "Görev Yöneticisi", Proc = "Taskmgr", Path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "Taskmgr.exe"), Args = "" }
            };

            foreach (var c in knownCandidates)
            {
                if (File.Exists(c.Path))
                {
                    addAppEntry(c.Name, c.Proc, c.Path, c.Args, c.Path, "installed");
                }
            }

            // 3. Scan User Desktop & Public Desktop shortcuts (.lnk and .url) + Start Menu shortcuts
            string[] shortcutDirs = new[]
            {
                IsRunningAsSystemAccount() ? Path.Combine(userProfDir, "Desktop") : Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                Path.Combine(userProfDir, "Desktop"),
                Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory),
                IsRunningAsSystemAccount() ? Path.Combine(userProfDir, @"AppData\Roaming\Microsoft\Windows\Start Menu") : Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
                Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu)
            };

            foreach (var dir in shortcutDirs)
            {
                if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) continue;
                bool isDesktopDir = dir.IndexOf("Desktop", StringComparison.OrdinalIgnoreCase) >= 0;

                if (isDesktopDir)
                {
                    try
                    {
                        foreach (var urlFile in Directory.GetFiles(dir, "*.url"))
                        {
                            string name = Path.GetFileNameWithoutExtension(urlFile);
                            string uTarget, uIcon;
                            int uIdx;
                            ParseInternetShortcutUrl(urlFile, out uTarget, out uIcon, out uIdx);
                            if (!string.IsNullOrEmpty(uTarget) && !string.IsNullOrEmpty(uIcon) && File.Exists(uIcon))
                            {
                                addAppEntry(name, name, urlFile, "", uIcon, "installed");
                            }
                        }
                    }
                    catch { }
                }

                foreach (var lnk in SafeEnumerateLnkFiles(dir))
                {
                    // Skip Windows Administrative / System Tools / Accessibility subfolders in Start Menu
                    if (!isDesktopDir &&
                        (lnk.IndexOf("\\Windows Tools\\", StringComparison.OrdinalIgnoreCase) >= 0 ||
                         lnk.IndexOf("\\Administrative Tools\\", StringComparison.OrdinalIgnoreCase) >= 0 ||
                         lnk.IndexOf("\\System Tools\\", StringComparison.OrdinalIgnoreCase) >= 0 ||
                         lnk.IndexOf("\\Accessibility\\", StringComparison.OrdinalIgnoreCase) >= 0 ||
                         lnk.IndexOf("\\Accessories\\", StringComparison.OrdinalIgnoreCase) >= 0 ||
                         lnk.IndexOf("\\Maintenance\\", StringComparison.OrdinalIgnoreCase) >= 0))
                    {
                        continue;
                    }

                    string name = Path.GetFileNameWithoutExtension(lnk);
                    if (IsNoisyShortcutOrExe(name, lnk)) continue;

                    string targetExe, targetArgs, iconLoc;
                    int iconIdx;
                    ResolveShortcutInfo(lnk, out targetExe, out targetArgs, out iconLoc, out iconIdx);
                    if (!string.IsNullOrEmpty(targetExe) && IsNoisyShortcutOrExe(name, targetExe)) continue;

                    string launchTarget = (!string.IsNullOrEmpty(targetExe) && File.Exists(targetExe)) ? targetExe : lnk;
                    string iconSource = (!string.IsNullOrEmpty(iconLoc) && File.Exists(iconLoc))
                        ? (iconLoc + "," + iconIdx)
                        : (!string.IsNullOrEmpty(targetExe) && File.Exists(targetExe) ? targetExe : lnk);

                    string procName = (!string.IsNullOrEmpty(targetExe) && targetExe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                        ? Path.GetFileNameWithoutExtension(targetExe)
                        : name;

                    addAppEntry(name, procName, launchTarget, targetArgs, iconSource, "installed");
                }
            }

            // 4. Include any currently open user applications not already in the list
            foreach (var w in GetOpenWindows())
            {
                string proc = Convert.ToString(w["processName"]);
                string rawProc = w.ContainsKey("rawProcessName") ? Convert.ToString(w["rawProcessName"]) : proc;
                string exe = Convert.ToString(w["exePath"]);
                if (string.IsNullOrEmpty(proc) || string.IsNullOrEmpty(exe)) continue;
                if (apps.ContainsKey(proc) || apps.ContainsKey(rawProc)) continue;
                if (exe.IndexOf(@"\WindowsApps\", StringComparison.OrdinalIgnoreCase) >= 0) continue;

                string friendly = proc;
                try
                {
                    var fvi = FileVersionInfo.GetVersionInfo(exe);
                    if (!string.IsNullOrWhiteSpace(fvi.ProductName) && fvi.ProductName.Length <= 34 &&
                        fvi.ProductName.IndexOf("Operating System", StringComparison.OrdinalIgnoreCase) < 0 &&
                        !fvi.ProductName.EndsWith(".Root", StringComparison.OrdinalIgnoreCase))
                    {
                        friendly = fvi.ProductName.Trim();
                    }
                    else if (!string.IsNullOrWhiteSpace(fvi.FileDescription) && fvi.FileDescription.Length <= 34 &&
                             !fvi.FileDescription.EndsWith(".Root", StringComparison.OrdinalIgnoreCase))
                    {
                        friendly = fvi.FileDescription.Trim();
                    }
                }
                catch { }

                addAppEntry(friendly, proc, exe, "", exe, "running");
            }

            var finalList = new List<Dictionary<string, object>>(apps.Values);
            finalList.Sort((a, b) => string.Compare(Convert.ToString(a["name"]), Convert.ToString(b["name"]), StringComparison.CurrentCultureIgnoreCase));
            return finalList;
        }

        private static IEnumerable<string> SafeEnumerateLnkFiles(string rootDir)
        {
            var list = new List<string>();
            var stack = new Stack<string>();
            stack.Push(rootDir);
            while (stack.Count > 0)
            {
                string current = stack.Pop();
                try
                {
                    foreach (var f in Directory.GetFiles(current, "*.lnk"))
                        list.Add(f);
                }
                catch { }
                try
                {
                    foreach (var d in Directory.GetDirectories(current))
                        stack.Push(d);
                }
                catch { }
            }
            return list;
        }

        #endregion

        #region Remote Control: Live Screen Capture & Input Simulation

        private static ImageCodecInfo jpegEncoder = null;
        private static ImageCodecInfo GetJpegEncoder()
        {
            if (jpegEncoder != null) return jpegEncoder;
            foreach (var codec in ImageCodecInfo.GetImageDecoders())
            {
                if (codec.FormatID == ImageFormat.Jpeg.Guid)
                {
                    jpegEncoder = codec;
                    return jpegEncoder;
                }
            }
            return null;
        }

        private static List<MonitorData> cachedMonitorsBounds = null;
        private static long cachedMonitorsTick = 0;

        private static MonitorData GetTargetMonitorBounds(int monitorIndex)
        {
            long nowTick = Environment.TickCount;
            var monitors = cachedMonitorsBounds;
            if (monitors == null || Math.Abs(nowTick - cachedMonitorsTick) > 2500)
            {
                monitors = GetMonitorsList();
                cachedMonitorsBounds = monitors;
                cachedMonitorsTick = nowTick;
            }
            if (monitors.Count == 0)
            {
                return new MonitorData { index = 0, x = 0, y = 0, width = 1920, height = 1080 };
            }
            if (monitorIndex == -1)
            {
                int minX = int.MaxValue, minY = int.MaxValue, maxR = int.MinValue, maxB = int.MinValue;
                foreach (var m in monitors)
                {
                    if (m.x < minX) minX = m.x;
                    if (m.y < minY) minY = m.y;
                    if (m.x + m.width > maxR) maxR = m.x + m.width;
                    if (m.y + m.height > maxB) maxB = m.y + m.height;
                }
                return new MonitorData
                {
                    index = -1,
                    id = "ALL_MONITORS",
                    friendlyName = "Tüm Ekranlar",
                    x = minX,
                    y = minY,
                    width = Math.Max(1, maxR - minX),
                    height = Math.Max(1, maxB - minY)
                };
            }
            if (monitorIndex < 0 || monitorIndex >= monitors.Count) monitorIndex = 0;
            return monitors[monitorIndex];
        }


        private class CaptureWorkerSlot
        {
            public object LockObj = new object();
            public Bitmap FullBmp;
            public Graphics FullGraphics;
            public Bitmap ScaledBmp;
            public Graphics ScaledGraphics;
            public EncoderParameters EncParams;
            public long LastQuality = -1;
            public MemoryStream EncodeStream = new MemoryStream(131072);
        }

        private static CaptureWorkerSlot[] captureSlots = new CaptureWorkerSlot[]
        {
            new CaptureWorkerSlot(),
            new CaptureWorkerSlot(),
            new CaptureWorkerSlot()
        };
        private static Dictionary<IntPtr, Point> cursorHotspotCache = new Dictionary<IntPtr, Point>();

        private static byte[] CaptureScreenRawJpeg(
            int monitorIndex,
            int maxWidth,
            long quality,
            bool drawCursor,
            out int dstW,
            out int dstH,
            out int srcW,
            out int srcH,
            out double curNormX,
            out double curNormY
        )
        {
            SyncThreadToInputDesktop();
            var mon = GetTargetMonitorBounds(monitorIndex);
            srcW = Math.Max(1, mon.width);
            srcH = Math.Max(1, mon.height);

            double scale = srcW > maxWidth ? (double)maxWidth / srcW : 1.0;
            dstW = Math.Max(1, (int)Math.Round(srcW * scale));
            dstH = Math.Max(1, (int)Math.Round(srcH * scale));

            Point curPt = Cursor.Position;
            curNormX = Math.Max(0.0, Math.Min(1.0, (double)(curPt.X - mon.x) / srcW));
            curNormY = Math.Max(0.0, Math.Min(1.0, (double)(curPt.Y - mon.y) / srcH));

            int slotIdx = monitorIndex < 0 ? 2 : (monitorIndex % 2);
            CaptureWorkerSlot slot = captureSlots[slotIdx];

            lock (slot.LockObj)
            {
                if (slot.ScaledBmp == null || slot.ScaledBmp.Width != dstW || slot.ScaledBmp.Height != dstH)
                {
                    if (slot.ScaledGraphics != null) { try { slot.ScaledGraphics.Dispose(); } catch { } }
                    if (slot.ScaledBmp != null) { try { slot.ScaledBmp.Dispose(); } catch { } }
                    slot.ScaledBmp = new Bitmap(dstW, dstH, PixelFormat.Format32bppRgb);
                    slot.ScaledGraphics = Graphics.FromImage(slot.ScaledBmp);
                    slot.ScaledGraphics.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceCopy;
                    slot.ScaledGraphics.CompositingQuality = System.Drawing.Drawing2D.CompositingQuality.HighSpeed;
                    slot.ScaledGraphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Bilinear;
                    slot.ScaledGraphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.None;
                    slot.ScaledGraphics.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighSpeed;
                }

                // One-shot thumbnail capture (live streaming uses ScreenStreamer.cs)
                {
                    if (slot.FullBmp == null || slot.FullBmp.Width != srcW || slot.FullBmp.Height != srcH)
                    {
                        if (slot.FullGraphics != null) { try { slot.FullGraphics.Dispose(); } catch { } }
                        if (slot.FullBmp != null) { try { slot.FullBmp.Dispose(); } catch { } }
                        slot.FullBmp = new Bitmap(srcW, srcH, PixelFormat.Format32bppRgb);
                        slot.FullGraphics = Graphics.FromImage(slot.FullBmp);
                        slot.FullGraphics.CompositingMode = System.Drawing.Drawing2D.CompositingMode.SourceCopy;
                        slot.FullGraphics.CompositingQuality = System.Drawing.Drawing2D.CompositingQuality.HighSpeed;
                    }

                    slot.FullGraphics.CopyFromScreen(mon.x, mon.y, 0, 0, new Size(srcW, srcH), CopyPixelOperation.SourceCopy);
                    slot.ScaledGraphics.DrawImage(slot.FullBmp, 0, 0, dstW, dstH);
                }

                if (drawCursor && !isPcLocked)
                {
                    try
                    {
                        CURSORINFO ci = new CURSORINFO();
                        ci.cbSize = Marshal.SizeOf(ci);
                        if (GetCursorInfo(out ci) && ci.flags == 1 && ci.hCursor != IntPtr.Zero)
                        {
                            Point hotPt;
                            lock (cursorHotspotCache)
                            {
                                if (!cursorHotspotCache.TryGetValue(ci.hCursor, out hotPt))
                                {
                                    ICONINFO ii;
                                    if (GetIconInfo(ci.hCursor, out ii))
                                    {
                                        hotPt = new Point(ii.xHotspot, ii.yHotspot);
                                        if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask);
                                        if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor);
                                    }
                                    else
                                    {
                                        hotPt = new Point(0, 0);
                                    }
                                    cursorHotspotCache[ci.hCursor] = hotPt;
                                }
                            }

                            int curX = (int)Math.Round(((ci.ptScreenPos.X - mon.x) - hotPt.X) * scale);
                            int curY = (int)Math.Round(((ci.ptScreenPos.Y - mon.y) - hotPt.Y) * scale);
                            if (curX >= -32 && curX < dstW && curY >= -32 && curY < dstH)
                            {
                                IntPtr hdc = slot.ScaledGraphics.GetHdc();
                                DrawIcon(hdc, curX, curY, ci.hCursor);
                                slot.ScaledGraphics.ReleaseHdc(hdc);
                            }
                        }
                    }
                    catch { }
                }

                Bitmap encodeTarget = slot.ScaledBmp;
                slot.EncodeStream.SetLength(0);
                var enc = GetJpegEncoder();
                if (enc != null)
                {
                    if (slot.EncParams == null || slot.LastQuality != quality)
                    {
                        if (slot.EncParams != null) { try { slot.EncParams.Dispose(); } catch { } }
                        slot.EncParams = new EncoderParameters(1);
                        slot.EncParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
                        slot.LastQuality = quality;
                    }
                    encodeTarget.Save(slot.EncodeStream, enc, slot.EncParams);
                }
                else
                {
                    encodeTarget.Save(slot.EncodeStream, ImageFormat.Jpeg);
                }
                byte[] encodedJpeg = slot.EncodeStream.ToArray();
                return encodedJpeg;
            }
        }

        private static void StartFastInputServer()
        {
            Thread inputServerThread = new Thread(() =>
            {
                try
                {
                    int inputPort = 4853;
                    int envInputPort;
                    if (int.TryParse(Environment.GetEnvironmentVariable("TAHABLT_INPUT_PORT") ?? "", out envInputPort) && envInputPort > 0) inputPort = envInputPort;
                    TcpListener listener = new TcpListener(IPAddress.Loopback, inputPort);
                    listener.Start();
                    while (true)
                    {
                        TcpClient client = listener.AcceptTcpClient();
                        Thread clientThread = new Thread(() =>
                        {
                            try
                            {
                                client.NoDelay = true;
                                NetworkStream inputStream = client.GetStream();
                                if (!CheckIpcKey(inputStream)) return;
                                using (StreamReader reader = new StreamReader(inputStream, Encoding.UTF8))
                                {
                                    string line;
                                    while ((line = reader.ReadLine()) != null)
                                    {
                                        if (string.IsNullOrWhiteSpace(line)) continue;
                                        Dictionary<string, object> args;
                                        try
                                        {
                                            args = serializer.Deserialize<Dictionary<string, object>>(line);
                                        }
                                        catch
                                        {
                                            return; // not our protocol (e.g. an HTTP request): drop the connection
                                        }
                                        try
                                        {
                                            if (args != null) SendInputCommand(args);
                                        }
                                        catch { }
                                    }
                                }
                            }
                            catch { }
                            finally
                            {
                                try { client.Close(); } catch { }
                            }
                        });
                        clientThread.Priority = ThreadPriority.Highest;
                        clientThread.IsBackground = true;
                        clientThread.Start();
                    }
                }
                catch { }
            });
            inputServerThread.Priority = ThreadPriority.Highest;
            inputServerThread.IsBackground = true;
            inputServerThread.Start();
        }

        private static object CaptureScreenCommand(Dictionary<string, object> args)
        {
            int monitorIndex = args.ContainsKey("monitorIndex") ? Convert.ToInt32(args["monitorIndex"]) : 0;
            int maxWidth = args.ContainsKey("maxWidth") ? Convert.ToInt32(args["maxWidth"]) : 1920;
            long quality = args.ContainsKey("quality") ? Convert.ToInt64(args["quality"]) : 80L;
            bool drawCursor = !args.ContainsKey("drawCursor") || Convert.ToBoolean(args["drawCursor"]);

            int dstW, dstH, srcW, srcH;
            double curNormX, curNormY;
            byte[] jpegBytes = CaptureScreenRawJpeg(monitorIndex, maxWidth, quality, drawCursor, out dstW, out dstH, out srcW, out srcH, out curNormX, out curNormY);

            return new
            {
                monitorIndex = monitorIndex,
                width = dstW,
                height = dstH,
                sourceWidth = srcW,
                sourceHeight = srcH,
                cursorNormX = Math.Round(curNormX, 4),
                cursorNormY = Math.Round(curNormY, 4),
                jpeg = Convert.ToBase64String(jpegBytes)
            };
        }

        // Sequence number of the last pointer input the phone sent and we applied. Frames echo it, so the phone
        // keeps its predicted cursor until the PC has caught up instead of guessing with a timer (which snapped the
        // cursor back to stale positions on slow links).
        private static volatile int lastInputSeq;

        private static object SendInputCommand(Dictionary<string, object> args)
        {
            SyncThreadToInputDesktop();
            object result = ApplyInputCommand(args);
            // Published only after the input is applied, so a frame carrying this number also carries its effect
            if (args.ContainsKey("seq"))
            {
                try { lastInputSeq = Convert.ToInt32(args["seq"]) & 0xFFFF; } catch { }
            }
            return result;
        }

        private static void MoveCursorHardware(int targetX, int targetY)
        {
            SetCursorPos(targetX, targetY);
            Rectangle vs = SystemInformation.VirtualScreen;
            int vx = vs.X;
            int vy = vs.Y;
            int vw = Math.Max(1, vs.Width);
            int vh = Math.Max(1, vs.Height);
            int absX = (int)Math.Round(((double)(targetX - vx) * 65535.0) / Math.Max(1, vw - 1));
            int absY = (int)Math.Round(((double)(targetY - vy) * 65535.0) / Math.Max(1, vh - 1));
            mouse_event(MOUSEEVENTF_MOVE | 0x8000 | 0x4000, absX, absY, 0, IntPtr.Zero);
        }

        private static object ApplyInputCommand(Dictionary<string, object> args)
        {
            string type = args.ContainsKey("type") ? Convert.ToString(args["type"]) : "";
            bool hasExplicitMon = args.ContainsKey("monitorIndex");
            int monIdx = hasExplicitMon ? Convert.ToInt32(args["monitorIndex"]) : 0;
            var mon = GetTargetMonitorBounds(type == "mouse_move_rel" && !hasExplicitMon ? -1 : monIdx);

            if (type == "touch")
            {
                return HandleTouchInput(args, mon);
            }
            else if (type == "mouse_move_rel")
            {
                int dx = args.ContainsKey("dx") ? Convert.ToInt32(Math.Round(Convert.ToDouble(args["dx"]))) : 0;
                int dy = args.ContainsKey("dy") ? Convert.ToInt32(Math.Round(Convert.ToDouble(args["dy"]))) : 0;
                Point p = Cursor.Position;
                int nextX = Math.Max(mon.x, Math.Min(mon.x + mon.width - 1, p.X + dx));
                int nextY = Math.Max(mon.y, Math.Min(mon.y + mon.height - 1, p.Y + dy));
                MoveCursorHardware(nextX, nextY);
                double nx = Math.Max(0.0, Math.Min(1.0, (double)(nextX - mon.x) / Math.Max(1, mon.width)));
                double ny = Math.Max(0.0, Math.Min(1.0, (double)(nextY - mon.y) / Math.Max(1, mon.height)));
                return new { ok = true, normX = Math.Round(nx, 4), normY = Math.Round(ny, 4) };
            }
            else if (type == "mouse_move_abs")
            {
                double nx = args.ContainsKey("x") ? Math.Max(0.0, Math.Min(1.0, Convert.ToDouble(args["x"]))) : 0.5;
                double ny = args.ContainsKey("y") ? Math.Max(0.0, Math.Min(1.0, Convert.ToDouble(args["y"]))) : 0.5;
                int targetX = mon.x + (int)Math.Round(nx * mon.width);
                int targetY = mon.y + (int)Math.Round(ny * mon.height);
                MoveCursorHardware(targetX, targetY);
                return new { ok = true, normX = Math.Round(nx, 4), normY = Math.Round(ny, 4) };
            }
            else if (type == "mouse_down")
            {
                if (args.ContainsKey("x") && args.ContainsKey("y"))
                {
                    double nx = Math.Max(0.0, Math.Min(1.0, Convert.ToDouble(args["x"])));
                    double ny = Math.Max(0.0, Math.Min(1.0, Convert.ToDouble(args["y"])));
                    MoveCursorHardware(NormToScreen(mon.x, mon.width, nx), NormToScreen(mon.y, mon.height, ny));
                }
                string btn = args.ContainsKey("button") ? Convert.ToString(args["button"]) : "left";
                if (btn == "right") mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, IntPtr.Zero);
                else if (btn == "middle") mouse_event(MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, IntPtr.Zero);
                else mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, IntPtr.Zero);
                return new { ok = true, holding = true };
            }
            else if (type == "mouse_up")
            {
                if (args.ContainsKey("x") && args.ContainsKey("y"))
                {
                    double nx = Math.Max(0.0, Math.Min(1.0, Convert.ToDouble(args["x"])));
                    double ny = Math.Max(0.0, Math.Min(1.0, Convert.ToDouble(args["y"])));
                    MoveCursorHardware(NormToScreen(mon.x, mon.width, nx), NormToScreen(mon.y, mon.height, ny));
                }
                string btn = args.ContainsKey("button") ? Convert.ToString(args["button"]) : "left";
                if (btn == "right") mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, IntPtr.Zero);
                else if (btn == "middle") mouse_event(MOUSEEVENTF_MIDDLEUP, 0, 0, 0, IntPtr.Zero);
                else mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
                return new { ok = true, holding = false };
            }
            else if (type == "mouse_click")
            {
                if (args.ContainsKey("x") && args.ContainsKey("y"))
                {
                    double nx = Math.Max(0.0, Math.Min(1.0, Convert.ToDouble(args["x"])));
                    double ny = Math.Max(0.0, Math.Min(1.0, Convert.ToDouble(args["y"])));
                    MoveCursorHardware(NormToScreen(mon.x, mon.width, nx), NormToScreen(mon.y, mon.height, ny));
                }

                string btn = args.ContainsKey("button") ? Convert.ToString(args["button"]) : "left";
                bool dbl = args.ContainsKey("double") && Convert.ToBoolean(args["double"]);

                if (btn == "right")
                {
                    mouse_event(MOUSEEVENTF_RIGHTDOWN | MOUSEEVENTF_RIGHTUP, 0, 0, 0, IntPtr.Zero);
                }
                else if (btn == "middle")
                {
                    mouse_event(MOUSEEVENTF_MIDDLEDOWN | MOUSEEVENTF_MIDDLEUP, 0, 0, 0, IntPtr.Zero);
                }
                else
                {
                    mouse_event(MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
                    if (dbl)
                    {
                        Thread.Sleep(25);
                        mouse_event(MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP, 0, 0, 0, IntPtr.Zero);
                    }
                }
                return new { ok = true };
            }
            else if (type == "mouse_scroll")
            {
                int deltaY = args.ContainsKey("deltaY") ? Convert.ToInt32(args["deltaY"]) : 0;
                int deltaX = args.ContainsKey("deltaX") ? Convert.ToInt32(args["deltaX"]) : 0;
                if (deltaY != 0)
                    mouse_event(MOUSEEVENTF_WHEEL, 0, 0, (uint)deltaY, IntPtr.Zero);
                if (deltaX != 0)
                    mouse_event(MOUSEEVENTF_HWHEEL, 0, 0, (uint)deltaX, IntPtr.Zero);
                return new { ok = true };
            }
            else if (type == "text")
            {
                string text = args.ContainsKey("text") ? Convert.ToString(args["text"]) : "";
                if (!string.IsNullOrEmpty(text))
                {
                    var inputs = new List<INPUT>();
                    foreach (char c in text)
                    {
                        inputs.Add(new INPUT
                        {
                            type = INPUT_KEYBOARD,
                            U = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = KEYEVENTF_UNICODE } }
                        });
                        inputs.Add(new INPUT
                        {
                            type = INPUT_KEYBOARD,
                            U = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } }
                        });
                    }
                    SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
                }
                return new { ok = true };
            }
            else if (type == "key")
            {
                string key = args.ContainsKey("key") ? Convert.ToString(args["key"]).ToUpperInvariant() : "";
                SendKeyCombo(key);
                return new { ok = true };
            }

            return new { ok = false };
        }

        // Normalized 0..1 -> pixel inside the monitor (x=1.0 must stay on this monitor, not jump to the next one)
        private static int NormToScreen(int origin, int size, double norm)
        {
            int px = (int)Math.Floor(norm * size);
            return origin + Math.Max(0, Math.Min(size - 1, px));
        }

        private static bool IsExtendedVk(ushort vk)
        {
            switch (vk)
            {
                case 0x21: case 0x22: case 0x23: case 0x24: // PGUP PGDN END HOME
                case 0x25: case 0x26: case 0x27: case 0x28: // arrows
                case 0x2D: case 0x2E: // INSERT DELETE
                case 0x5B: case 0x5C: case 0x5D: // LWIN RWIN APPS
                case 0xA3: case 0xA5: // RCTRL RALT
                case 0x6F: case 0x90: case 0x2C: // NUMPAD DIVIDE, NUMLOCK, SNAPSHOT
                    return true;
            }
            return false;
        }

        private static void SendKeyCombo(string combo)
        {
            var parts = combo.Split('+');
            var vks = new List<ushort>();
            foreach (var p in parts)
            {
                ushort vk = MapKeyNameToVk(p.Trim());
                if (vk != 0) vks.Add(vk);
            }
            if (vks.Count == 0) return;

            var inputs = new List<INPUT>();
            foreach (var vk in vks)
            {
                inputs.Add(new INPUT
                {
                    type = INPUT_KEYBOARD,
                    U = new InputUnion { ki = new KEYBDINPUT { wVk = vk, dwFlags = IsExtendedVk(vk) ? KEYEVENTF_EXTENDEDKEY : 0u } }
                });
            }
            for (int i = vks.Count - 1; i >= 0; i--)
            {
                inputs.Add(new INPUT
                {
                    type = INPUT_KEYBOARD,
                    U = new InputUnion { ki = new KEYBDINPUT { wVk = vks[i], dwFlags = KEYEVENTF_KEYUP | (IsExtendedVk(vks[i]) ? KEYEVENTF_EXTENDEDKEY : 0u) } }
                });
            }
            SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
        }

        private static ushort MapKeyNameToVk(string k)
        {
            switch (k)
            {
                case "CTRL": case "CONTROL": return 0x11;
                case "ALT": return 0x12;
                case "SHIFT": return 0x10;
                case "WIN": case "LWIN": return 0x5B;
                case "ENTER": case "RETURN": return 0x0D;
                case "ESC": case "ESCAPE": return 0x1B;
                case "BACKSPACE": case "BS": return 0x08;
                case "TAB": return 0x09;
                case "SPACE": return 0x20;
                case "DELETE": case "DEL": return 0x2E;
                case "UP": return 0x26;
                case "DOWN": return 0x28;
                case "LEFT": return 0x25;
                case "RIGHT": return 0x27;
                case "HOME": return 0x24;
                case "END": return 0x23;
                case "PGUP": return 0x21;
                case "PGDN": return 0x22;
                case "F1": return 0x70;
                case "F2": return 0x71;
                case "F3": return 0x72;
                case "F4": return 0x73;
                case "F5": return 0x74;
                case "F6": return 0x75;
                case "F7": return 0x76;
                case "F8": return 0x77;
                case "F9": return 0x78;
                case "F10": return 0x79;
                case "F11": return 0x7A;
                case "F12": return 0x7B;
                case "VOLUME_MUTE": return 0xAD;
                case "VOLUME_DOWN": return 0xAE;
                case "VOLUME_UP": return 0xAF;
                case "MEDIA_NEXT": return 0xB0;
                case "MEDIA_PREV": return 0xB1;
                case "MEDIA_STOP": return 0xB2;
                case "MEDIA_PLAY_PAUSE": return 0xB3;
                default:
                    if (k.Length == 1)
                    {
                        char c = k[0];
                        if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))
                            return (ushort)c;
                    }
                    return 0;
            }
        }

        #endregion

        #region Audio Mixer & System Control

        private static Dictionary<string, object> lastKnownMediaCandidate = null;
        private static Dictionary<uint, long> lastAudibleTickByPid = new Dictionary<uint, long>();
        private static Dictionary<uint, string> lastTitleByPid = new Dictionary<uint, string>();
        private static Dictionary<uint, long> lastTitleChangeTickByPid = new Dictionary<uint, long>();
        private static long lastMediaKeySentTick = 0;

        private static bool isPcLocked = false;
        private static List<Form> lockShieldForms = new List<Form>();
        private static IntPtr keyboardHookId = IntPtr.Zero;
        private static IntPtr mouseHookId = IntPtr.Zero;
        private static LowLevelHookProc keyboardHookDelegate = KeyboardHookCallback;
        private static LowLevelHookProc mouseHookDelegate = MouseHookCallback;

        private static object clipboardHistoryLock = new object();
        private static List<Dictionary<string, object>> clipboardHistory = new List<Dictionary<string, object>>();
        private static string lastSeenClipboardText = "";

        private static IntPtr KeyboardHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0 && isPcLocked)
            {
                try
                {
                    // KBDLLHOOKSTRUCT.flags is at byte offset 8; LLKHF_INJECTED = 0x10
                    int flags = Marshal.ReadInt32(lParam, 8);
                    if ((flags & 0x10) == 0)
                    {
                        return new IntPtr(1); // Block all physical keyboard keys (Win, Alt+Tab, Alt+F4, Ctrl+Esc, typing)
                    }
                }
                catch
                {
                    return new IntPtr(1);
                }
            }
            return CallNextHookEx(keyboardHookId, nCode, wParam, lParam);
        }

        private static IntPtr MouseHookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0 && isPcLocked)
            {
                try
                {
                    // MSLLHOOKSTRUCT.flags is at byte offset 12; LLMHF_INJECTED = 0x01
                    int flags = Marshal.ReadInt32(lParam, 12);
                    if ((flags & 0x01) == 0)
                    {
                        return new IntPtr(1); // Block all physical mouse movement, clicks, and wheel events
                    }
                }
                catch
                {
                    return new IntPtr(1);
                }
            }
            return CallNextHookEx(mouseHookId, nCode, wParam, lParam);
        }

        private static List<IntPtr> hiddenShellWindowsDuringLock = new List<IntPtr>();

        private static void SetTaskbarAndShellOverlaysVisibilityForLock(bool hideOverlays)
        {
            try
            {
                if (hideOverlays)
                {
                    string[] shellClasses = new[]
                    {
                        "Shell_TrayWnd",
                        "Shell_SecondaryTrayWnd",
                        "NotifyIconOverflowWindow",
                        "TopLevelWindowForOverflowXamlIsland",
                        "XamlExplorerHostIslandWindow"
                    };
                    foreach (string cls in shellClasses)
                    {
                        IntPtr hw = FindWindow(cls, null);
                        if (hw != IntPtr.Zero && IsWindowVisible(hw))
                        {
                            ShowWindow(hw, SW_HIDE);
                            if ((cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd") && !hiddenShellWindowsDuringLock.Contains(hw))
                            {
                                hiddenShellWindowsDuringLock.Add(hw);
                            }
                        }
                    }

                    // Also enumerate top-level windows to catch multi-monitor secondary taskbars & Windows toast/action center popups
                    EnumWindows((hWnd, lParam) =>
                    {
                        if (!IsWindowVisible(hWnd)) return true;
                        StringBuilder sbCls = new StringBuilder(128);
                        if (GetClassName(hWnd, sbCls, sbCls.Capacity) <= 0) return true;
                        string clsName = sbCls.ToString();

                        if (clsName == "Shell_SecondaryTrayWnd" || clsName == "Shell_TrayWnd")
                        {
                            ShowWindow(hWnd, SW_HIDE);
                            if (!hiddenShellWindowsDuringLock.Contains(hWnd))
                                hiddenShellWindowsDuringLock.Add(hWnd);
                        }
                        else if (clsName == "Windows.UI.Core.CoreWindow" ||
                                 clsName == "XamlExplorerHostIslandWindow" ||
                                 clsName == "TopLevelWindowForOverflowXamlIsland")
                        {
                            uint pid = 0;
                            GetWindowThreadProcessId(hWnd, out pid);
                            if (pid != 0)
                            {
                                try
                                {
                                    string pName = Process.GetProcessById((int)pid).ProcessName;
                                    if (pName.Equals("ShellExperienceHost", StringComparison.OrdinalIgnoreCase) ||
                                        pName.Equals("StartMenuExperienceHost", StringComparison.OrdinalIgnoreCase) ||
                                        pName.Equals("SearchHost", StringComparison.OrdinalIgnoreCase))
                                    {
                                        PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                                        ShowWindow(hWnd, SW_HIDE);
                                    }
                                }
                                catch { }
                            }
                        }
                        return true;
                    }, IntPtr.Zero);
                }
                else
                {
                    foreach (IntPtr hw in hiddenShellWindowsDuringLock)
                    {
                        try
                        {
                            if (hw != IntPtr.Zero)
                                ShowWindow(hw, SW_SHOW);
                        }
                        catch { }
                    }
                    hiddenShellWindowsDuringLock.Clear();

                    IntPtr mainTray = FindWindow("Shell_TrayWnd", null);
                    if (mainTray != IntPtr.Zero) ShowWindow(mainTray, SW_SHOW);
                    IntPtr secTray = FindWindow("Shell_SecondaryTrayWnd", null);
                    if (secTray != IntPtr.Zero) ShowWindow(secTray, SW_SHOW);
                }
            }
            catch { }
        }

        private static void EnforceLockShieldWatchdogOnSta()
        {
            if (!isPcLocked) return;
            try
            {
                SetTaskbarAndShellOverlaysVisibilityForLock(true);

                lock (lockShieldForms)
                {
                    IntPtr fg = GetForegroundWindow();
                    bool fgIsShield = false;
                    foreach (var lf in lockShieldForms)
                    {
                        if (lf != null && !lf.IsDisposed && lf.Handle == fg)
                        {
                            fgIsShield = true;
                            break;
                        }
                    }

                    for (int i = 0; i < lockShieldForms.Count; i++)
                    {
                        var lf = lockShieldForms[i];
                        if (lf != null && !lf.IsDisposed && lf.Visible)
                        {
                            BringWindowToTop(lf.Handle);
                            SetWindowPos(lf.Handle, HWND_TOPMOST, lf.Bounds.X, lf.Bounds.Y, lf.Bounds.Width, lf.Bounds.Height, SWP_SHOWWINDOW | (i == 0 && !fgIsShield ? 0u : SWP_NOACTIVATE));
                            if (i == 0 && !fgIsShield)
                            {
                                try { SetForegroundWindow(lf.Handle); } catch { }
                                try { lf.Activate(); } catch { }
                            }
                        }
                    }
                }
            }
            catch { }
        }

        private static void PaintMinimalLockIconOnly(object sender, PaintEventArgs e)
        {
            Form f = sender as Form;
            if (f == null) return;
            Graphics g = e.Graphics;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;

            int cx = f.ClientSize.Width / 2;
            int cy = f.ClientSize.Height / 2;

            // Subtle ambient circle container
            int circleRadius = 56;
            using (SolidBrush circleFill = new SolidBrush(Color.FromArgb(16, 20, 29)))
            using (Pen circlePen = new Pen(Color.FromArgb(38, 46, 64), 1.5f))
            {
                g.FillEllipse(circleFill, cx - circleRadius, cy - circleRadius, circleRadius * 2, circleRadius * 2);
                g.DrawEllipse(circlePen, cx - circleRadius, cy - circleRadius, circleRadius * 2, circleRadius * 2);
            }

            // Minimalist vector padlock shackle & body (no text at all)
            using (Pen lockPen = new Pen(Color.FromArgb(226, 232, 240), 3.2f))
            {
                lockPen.StartCap = System.Drawing.Drawing2D.LineCap.Round;
                lockPen.EndCap = System.Drawing.Drawing2D.LineCap.Round;
                lockPen.LineJoin = System.Drawing.Drawing2D.LineJoin.Round;

                // Shackle arch
                Rectangle shackleArc = new Rectangle(cx - 12, cy - 24, 24, 24);
                g.DrawArc(lockPen, shackleArc, 180f, 180f);
                g.DrawLine(lockPen, cx - 12, cy - 12, cx - 12, cy - 4);
                g.DrawLine(lockPen, cx + 12, cy - 12, cx + 12, cy - 4);

                // Padlock body
                Rectangle bodyRect = new Rectangle(cx - 19, cy - 4, 38, 28);
                int r = 7;
                using (System.Drawing.Drawing2D.GraphicsPath path = new System.Drawing.Drawing2D.GraphicsPath())
                {
                    path.AddArc(bodyRect.X, bodyRect.Y, r * 2, r * 2, 180, 90);
                    path.AddArc(bodyRect.Right - r * 2, bodyRect.Y, r * 2, r * 2, 270, 90);
                    path.AddArc(bodyRect.Right - r * 2, bodyRect.Bottom - r * 2, r * 2, r * 2, 0, 90);
                    path.AddArc(bodyRect.X, bodyRect.Bottom - r * 2, r * 2, r * 2, 90, 90);
                    path.CloseFigure();
                    g.DrawPath(lockPen, path);
                }

                // Keyhole dot & stem
                using (SolidBrush keyBrush = new SolidBrush(Color.FromArgb(226, 232, 240)))
                {
                    g.FillEllipse(keyBrush, cx - 3, cy + 5, 6, 6);
                }
                g.DrawLine(lockPen, cx, cy + 10, cx, cy + 16);
            }
        }

        private static void SetPcLockState(bool lockPc)
        {
            isPcLocked = lockPc;
            if (uiDispatcherForm != null && uiDispatcherForm.IsHandleCreated)
            {
                uiDispatcherForm.Invoke((MethodInvoker)delegate
                {
                    lock (lockShieldForms)
                    {
                        foreach (var f in lockShieldForms)
                        {
                            try
                            {
                                if (f != null && !f.IsDisposed)
                                {
                                    f.Hide();
                                    f.Close();
                                }
                            }
                            catch { }
                        }
                        lockShieldForms.Clear();

                        if (keyboardHookId != IntPtr.Zero)
                        {
                            try { UnhookWindowsHookEx(keyboardHookId); } catch { }
                            keyboardHookId = IntPtr.Zero;
                        }
                        if (mouseHookId != IntPtr.Zero)
                        {
                            try { UnhookWindowsHookEx(mouseHookId); } catch { }
                            mouseHookId = IntPtr.Zero;
                        }
                        try { ClipCursor(IntPtr.Zero); } catch { }

                        if (lockPc)
                        {
                            SetTaskbarAndShellOverlaysVisibilityForLock(true);

                            IntPtr hMod = GetModuleHandle(null);
                            keyboardHookId = SetWindowsHookEx(13, keyboardHookDelegate, hMod, 0);
                            mouseHookId = SetWindowsHookEx(14, mouseHookDelegate, hMod, 0);

                            try { Cursor.Hide(); } catch { }
                            Cursor invisibleCursor = null;
                            try
                            {
                                using (Bitmap bmp = new Bitmap(1, 1))
                                {
                                    bmp.SetPixel(0, 0, Color.FromArgb(0, 0, 0, 0));
                                    invisibleCursor = new Cursor(bmp.GetHicon());
                                }
                            }
                            catch { }

                            var monitors = GetMonitorsList();
                            for (int idx = 0; idx < monitors.Count; idx++)
                            {
                                var m = monitors[idx];
                                Form lf = new Form
                                {
                                    FormBorderStyle = FormBorderStyle.None,
                                    StartPosition = FormStartPosition.Manual,
                                    BackColor = Color.FromArgb(5, 6, 9),
                                    Bounds = new Rectangle(m.x, m.y, m.width, m.height),
                                    TopMost = true,
                                    ShowInTaskbar = false,
                                    KeyPreview = true,
                                    Cursor = invisibleCursor ?? Cursors.No
                                };
                                lf.MouseEnter += (s, e) => { try { Cursor.Hide(); } catch { } };
                                lf.MouseMove += (s, e) => { try { Cursor.Hide(); } catch { } };
                                lf.Paint += PaintMinimalLockIconOnly;
                                lf.FormClosing += (s, e) =>
                                {
                                    if (isPcLocked) e.Cancel = true;
                                };
                                lf.Show();
                                BringWindowToTop(lf.Handle);
                                SetWindowPos(lf.Handle, HWND_TOPMOST, m.x, m.y, m.width, m.height, SWP_SHOWWINDOW);
                                if (idx == 0)
                                {
                                    try { SetForegroundWindow(lf.Handle); } catch { }
                                    try { lf.Activate(); } catch { }
                                }
                                lockShieldForms.Add(lf);
                            }
                        }
                        else
                        {
                            SetTaskbarAndShellOverlaysVisibilityForLock(false);
                            try { Cursor.Show(); } catch { }
                        }
                    }
                });
            }

            if (monitorsManuallyOff)
            {
                ReassertMonitorsOffIfNeeded();
            }
        }

        private static string clipboardHistoryFilePath = ResolveClipboardHistoryPath();

        // Shared data folder (the install folder is read-only for standard users); migrates the old file once
        private static string ResolveClipboardHistoryPath()
        {
            string legacy = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "clipboard_history.json");
            try
            {
                string progDataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Bridge", "data");
                Directory.CreateDirectory(progDataDir);
                string target = Path.Combine(progDataDir, "clipboard_history.json");
                if (!File.Exists(target))
                {
                    // Pre-rebrand ("TahaBLT Connect") locations, newest first
                    foreach (string old in new[] {
                        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "TahaBLT Connect", "data", "clipboard_history.json"),
                        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TahaBLT Connect", "data", "clipboard_history.json"),
                        legacy })
                    {
                        if (File.Exists(old)) { File.Copy(old, target); break; }
                    }
                }
                return target;
            }
            catch
            {
                try
                {
                    string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Bridge", "data");
                    Directory.CreateDirectory(dir);
                    string target = Path.Combine(dir, "clipboard_history.json");
                    if (!File.Exists(target) && File.Exists(legacy)) File.Copy(legacy, target);
                    return target;
                }
                catch
                {
                    return legacy;
                }
            }
        }
        private static string lastSeenClipboardImageHash = "";
        private static Dictionary<string, Dictionary<string, object>> winRtHistoryItemCache = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);

        private static string EncodeClipboardImageToDataUrl(Image img, out int origW, out int origH, out string fastHash)
        {
            origW = 0;
            origH = 0;
            fastHash = "";
            if (img == null) return "";
            try
            {
                origW = img.Width;
                origH = img.Height;
                if (origW <= 0 || origH <= 0) return "";

                int maxDim = 720;
                double scale = 1.0;
                if (origW > maxDim || origH > maxDim)
                {
                    scale = Math.Min((double)maxDim / origW, (double)maxDim / origH);
                }
                int dstW = Math.Max(1, (int)Math.Round(origW * scale));
                int dstH = Math.Max(1, (int)Math.Round(origH * scale));

                using (Bitmap bmp = new Bitmap(dstW, dstH, PixelFormat.Format24bppRgb))
                {
                    using (Graphics g = Graphics.FromImage(bmp))
                    {
                        g.Clear(Color.FromArgb(15, 20, 28));
                        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;
                        g.DrawImage(img, 0, 0, dstW, dstH);
                    }

                    // Compute a fast deterministic content signature from sampled pixels
                    long h = ((long)origW << 16) ^ origH;
                    int stepX = Math.Max(1, dstW / 8);
                    int stepY = Math.Max(1, dstH / 8);
                    for (int sy = stepY / 2; sy < dstH; sy += stepY)
                    {
                        for (int sx = stepX / 2; sx < dstW; sx += stepX)
                        {
                            Color c = bmp.GetPixel(sx, sy);
                            h = ((h << 5) + h) ^ c.ToArgb();
                        }
                    }
                    fastHash = origW + "x" + origH + "_" + Math.Abs(h).ToString("X");

                    using (MemoryStream ms = new MemoryStream(32768))
                    {
                        var enc = GetJpegEncoder();
                        if (enc != null)
                        {
                            using (EncoderParameters ep = new EncoderParameters(1))
                            {
                                ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 78L);
                                bmp.Save(ms, enc, ep);
                            }
                        }
                        else
                        {
                            bmp.Save(ms, ImageFormat.Jpeg);
                        }
                        return "data:image/jpeg;base64," + Convert.ToBase64String(ms.ToArray());
                    }
                }
            }
            catch
            {
                return "";
            }
        }

        private static void LoadPersistedClipboardHistory()
        {
            try
            {
                if (File.Exists(clipboardHistoryFilePath))
                {
                    string json = File.ReadAllText(clipboardHistoryFilePath, Encoding.UTF8);
                    var list = serializer.Deserialize<List<Dictionary<string, object>>>(json);
                    if (list != null && list.Count > 0)
                    {
                        lock (clipboardHistoryLock)
                        {
                            clipboardHistory = list;
                            if (clipboardHistory.Count > 0)
                            {
                                var first = clipboardHistory[0];
                                if (first.ContainsKey("type") && Convert.ToString(first["type"]) == "image" && first.ContainsKey("imageHash"))
                                {
                                    lastSeenClipboardImageHash = Convert.ToString(first["imageHash"]);
                                }
                                else if (first.ContainsKey("text"))
                                {
                                    lastSeenClipboardText = Convert.ToString(first["text"]).Trim();
                                }
                            }
                        }
                    }
                }
            }
            catch { }
        }

        private static void SavePersistedClipboardHistory()
        {
            try
            {
                string json = "";
                lock (clipboardHistoryLock)
                {
                    json = serializer.Serialize(clipboardHistory);
                }
                File.WriteAllText(clipboardHistoryFilePath, json, Encoding.UTF8);
            }
            catch { }
        }

        private static void PollClipboardHistoryOnSta()
        {
            try
            {
                if (Clipboard.ContainsImage())
                {
                    try
                    {
                        using (Image clipImg = Clipboard.GetImage())
                        {
                            if (clipImg != null)
                            {
                                int w, h;
                                string imgHash;
                                string dataUrl = EncodeClipboardImageToDataUrl(clipImg, out w, out h, out imgHash);
                                if (!string.IsNullOrEmpty(dataUrl) && !string.IsNullOrEmpty(imgHash) && imgHash != lastSeenClipboardImageHash)
                                {
                                    lastSeenClipboardImageHash = imgHash;
                                    AddClipboardImageHistoryEntry(dataUrl, w, h, imgHash);
                                }
                            }
                        }
                    }
                    catch { }
                }

                string txt = GetCurrentClipboardTextSafe();
                if (string.IsNullOrWhiteSpace(txt) && Clipboard.ContainsText())
                {
                    try { txt = Clipboard.GetText(); } catch { }
                }
                if (string.IsNullOrWhiteSpace(txt)) return;
                string trimmed = txt.Trim();
                if (trimmed.Length == 0 || trimmed == lastSeenClipboardText) return;
                lastSeenClipboardText = trimmed;
                AddClipboardHistoryEntry(trimmed);
            }
            catch { }
        }

        private static void AddClipboardImageHistoryEntry(string dataUrl, int width, int height, string imageHash)
        {
            if (string.IsNullOrEmpty(dataUrl)) return;
            lock (clipboardHistoryLock)
            {
                for (int i = clipboardHistory.Count - 1; i >= 0; i--)
                {
                    if (clipboardHistory[i].ContainsKey("imageHash") &&
                        string.Equals(Convert.ToString(clipboardHistory[i]["imageHash"]), imageHash, StringComparison.Ordinal))
                    {
                        clipboardHistory.RemoveAt(i);
                    }
                }

                clipboardHistory.Insert(0, new Dictionary<string, object>
                {
                    { "id", "img_" + imageHash },
                    { "type", "image" },
                    { "image", dataUrl },
                    { "imageHash", imageHash },
                    { "width", width },
                    { "height", height },
                    { "text", "[Görsel " + width + "×" + height + "]" },
                    { "time", DateTime.Now.ToString("HH:mm:ss") },
                    { "charCount", 0 }
                });

                while (clipboardHistory.Count > 40)
                {
                    clipboardHistory.RemoveAt(clipboardHistory.Count - 1);
                }
            }
            SavePersistedClipboardHistory();
        }

        private static void AddClipboardHistoryEntry(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return;
            string clean = text.Trim();
            if (clean.Length > 12000) clean = clean.Substring(0, 12000);

            lock (clipboardHistoryLock)
            {
                for (int i = clipboardHistory.Count - 1; i >= 0; i--)
                {
                    string existingType = clipboardHistory[i].ContainsKey("type") ? Convert.ToString(clipboardHistory[i]["type"]) : "text";
                    if (existingType != "image" && string.Equals(Convert.ToString(clipboardHistory[i]["text"]), clean, StringComparison.Ordinal))
                    {
                        clipboardHistory.RemoveAt(i);
                    }
                }

                clipboardHistory.Insert(0, new Dictionary<string, object>
                {
                    { "id", Guid.NewGuid().ToString("N").Substring(0, 10) },
                    { "type", "text" },
                    { "text", clean },
                    { "time", DateTime.Now.ToString("HH:mm:ss") },
                    { "charCount", clean.Length }
                });

                while (clipboardHistory.Count > 40)
                {
                    clipboardHistory.RemoveAt(clipboardHistory.Count - 1);
                }
            }
            SavePersistedClipboardHistory();
        }

        private static MethodInfo winRtAsTaskGeneric = null;
        private static MethodInfo winRtAsStreamForReadMethod = null;
        private static object AwaitWinRtOperation(object asyncOp, Type resultType, int timeoutMs = 900)
        {
            if (asyncOp == null || resultType == null) return null;
            try
            {
                if (winRtAsTaskGeneric == null)
                {
                    foreach (MethodInfo m in typeof(System.WindowsRuntimeSystemExtensions).GetMethods())
                    {
                        if (m.Name == "AsTask" &&
                            m.IsGenericMethod &&
                            m.GetGenericArguments().Length == 1 &&
                            m.GetParameters().Length == 1 &&
                            m.GetParameters()[0].ParameterType.Name == "IAsyncOperation`1")
                        {
                            winRtAsTaskGeneric = m;
                            break;
                        }
                    }
                }
                if (winRtAsTaskGeneric == null) return null;
                MethodInfo closed = winRtAsTaskGeneric.MakeGenericMethod(resultType);
                Task task = (Task)closed.Invoke(null, new object[] { asyncOp });
                if (!task.Wait(timeoutMs)) return null;
                return task.GetType().GetProperty("Result").GetValue(task, null);
            }
            catch { return null; }
        }

        private static Stream ConvertWinRtStreamToNetStream(object winRtStream)
        {
            if (winRtStream == null) return null;
            try
            {
                if (winRtAsStreamForReadMethod == null)
                {
                    Type extType = typeof(System.WindowsRuntimeSystemExtensions).Assembly.GetType("System.IO.WindowsRuntimeStreamExtensions");
                    if (extType != null)
                    {
                        foreach (MethodInfo m in extType.GetMethods(BindingFlags.Public | BindingFlags.Static))
                        {
                            if (m.Name == "AsStreamForRead" && m.GetParameters().Length == 1)
                            {
                                winRtAsStreamForReadMethod = m;
                                break;
                            }
                        }
                    }
                }
                if (winRtAsStreamForReadMethod != null)
                {
                    return winRtAsStreamForReadMethod.Invoke(null, new object[] { winRtStream }) as Stream;
                }
            }
            catch { }
            return null;
        }

        private static long lastWinRtClipSyncTick = 0;
        private static void SyncWinRtClipboardHistory(bool force = false)
        {
            long nowTick = Environment.TickCount;
            if (!force && lastWinRtClipSyncTick != 0 && Math.Abs(nowTick - lastWinRtClipSyncTick) < 3000)
                return;
            lastWinRtClipSyncTick = nowTick;

            if (Thread.CurrentThread.GetApartmentState() == ApartmentState.STA)
            {
                try { Task.Run(() => SyncWinRtClipboardHistoryMta()).Wait(2400); } catch { }
            }
            else
            {
                SyncWinRtClipboardHistoryMta();
            }
        }

        private static void SyncWinRtClipboardHistoryMta()
        {
            try
            {
                Type clipType = Type.GetType("Windows.ApplicationModel.DataTransfer.Clipboard, Windows.ApplicationModel.DataTransfer, ContentType=WindowsRuntime");
                Type clipResType = Type.GetType("Windows.ApplicationModel.DataTransfer.ClipboardHistoryItemsResult, Windows.ApplicationModel.DataTransfer, ContentType=WindowsRuntime");
                Type clipItemType = Type.GetType("Windows.ApplicationModel.DataTransfer.ClipboardHistoryItem, Windows.ApplicationModel.DataTransfer, ContentType=WindowsRuntime");
                Type dpvType = Type.GetType("Windows.ApplicationModel.DataTransfer.DataPackageView, Windows.ApplicationModel.DataTransfer, ContentType=WindowsRuntime");
                Type streamRefType = Type.GetType("Windows.Storage.Streams.RandomAccessStreamReference, Windows.Storage.Streams, ContentType=WindowsRuntime");
                Type rasWithContentType = Type.GetType("Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime");
                if (clipType == null || clipResType == null || clipItemType == null || dpvType == null) return;

                object histOp = clipType.GetMethod("GetHistoryItemsAsync").Invoke(null, null);
                object histRes = AwaitWinRtOperation(histOp, clipResType, 1500);
                if (histRes == null) return;

                PropertyInfo itemsProp = clipResType.GetProperty("Items");
                if (itemsProp == null) return;
                IEnumerable items = itemsProp.GetValue(histRes, null) as IEnumerable;
                if (items == null) return;

                PropertyInfo contentProp = clipItemType.GetProperty("Content");
                PropertyInfo timestampProp = clipItemType.GetProperty("Timestamp");
                PropertyInfo idProp = clipItemType.GetProperty("Id");
                MethodInfo containsMethod = dpvType.GetMethod("Contains", new Type[] { typeof(string) });
                MethodInfo getTextMethod = dpvType.GetMethod("GetTextAsync", Type.EmptyTypes);
                MethodInfo getBitmapMethod = dpvType.GetMethod("GetBitmapAsync", Type.EmptyTypes);
                MethodInfo openReadMethod = streamRefType != null ? streamRefType.GetMethod("OpenReadAsync", Type.EmptyTypes) : null;
                if (contentProp == null) return;

                var winRtEntries = new List<Dictionary<string, object>>();
                int idx = 0;
                foreach (object item in items)
                {
                    if (idx >= 30) break;
                    try
                    {
                        string itemId = "";
                        if (idProp != null)
                        {
                            try { itemId = Convert.ToString(idProp.GetValue(item, null) ?? ""); } catch { }
                        }
                        if (string.IsNullOrEmpty(itemId)) itemId = "winv_" + idx;

                        lock (winRtHistoryItemCache)
                        {
                            Dictionary<string, object> cachedEntry;
                            if (winRtHistoryItemCache.TryGetValue(itemId, out cachedEntry) && cachedEntry != null)
                            {
                                winRtEntries.Add(cachedEntry);
                                idx++;
                                continue;
                            }
                        }

                        object content = contentProp.GetValue(item, null);
                        if (content == null) continue;

                        string timeStr = DateTime.Now.ToString("HH:mm:ss");
                        if (timestampProp != null)
                        {
                            try
                            {
                                DateTimeOffset dto = (DateTimeOffset)timestampProp.GetValue(item, null);
                                timeStr = dto.LocalDateTime.ToString("HH:mm:ss");
                            }
                            catch { }
                        }

                        bool hasBitmap = containsMethod != null && Convert.ToBoolean(containsMethod.Invoke(content, new object[] { "Bitmap" }));
                        bool hasText = containsMethod != null && Convert.ToBoolean(containsMethod.Invoke(content, new object[] { "Text" }));

                        if (hasBitmap && getBitmapMethod != null && openReadMethod != null && streamRefType != null && rasWithContentType != null)
                        {
                            try
                            {
                                object bmpRefOp = getBitmapMethod.Invoke(content, null);
                                object bmpRef = AwaitWinRtOperation(bmpRefOp, streamRefType, 700);
                                if (bmpRef != null)
                                {
                                    object openOp = openReadMethod.Invoke(bmpRef, null);
                                    object rasObj = AwaitWinRtOperation(openOp, rasWithContentType, 900);
                                    if (rasObj != null)
                                    {
                                        using (Stream netStream = ConvertWinRtStreamToNetStream(rasObj))
                                        {
                                            if (netStream != null)
                                            {
                                                using (Image rawImg = Image.FromStream(netStream))
                                                {
                                                    int w, h;
                                                    string imgHash;
                                                    string dataUrl = EncodeClipboardImageToDataUrl(rawImg, out w, out h, out imgHash);
                                                    if (!string.IsNullOrEmpty(dataUrl))
                                                    {
                                                        var imgEntry = new Dictionary<string, object>
                                                        {
                                                            { "id", itemId },
                                                            { "type", "image" },
                                                            { "image", dataUrl },
                                                            { "imageHash", imgHash },
                                                            { "width", w },
                                                            { "height", h },
                                                            { "text", "[Görsel " + w + "×" + h + "]" },
                                                            { "time", timeStr },
                                                            { "charCount", 0 }
                                                        };
                                                        lock (winRtHistoryItemCache)
                                                        {
                                                            winRtHistoryItemCache[itemId] = imgEntry;
                                                        }
                                                        winRtEntries.Add(imgEntry);
                                                        idx++;
                                                        continue;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            catch { }
                        }

                        if (hasText && getTextMethod != null)
                        {
                            object txtOp = getTextMethod.Invoke(content, null);
                            string textVal = Convert.ToString(AwaitWinRtOperation(txtOp, typeof(string), 450) ?? "").Trim();
                            if (string.IsNullOrEmpty(textVal)) continue;
                            if (textVal == "Test Windows Copy 12345") continue;
                            if (textVal.Length > 12000) textVal = textVal.Substring(0, 12000);

                            var txtEntry = new Dictionary<string, object>
                            {
                                { "id", itemId },
                                { "type", "text" },
                                { "text", textVal },
                                { "time", timeStr },
                                { "charCount", textVal.Length }
                            };
                            lock (winRtHistoryItemCache)
                            {
                                winRtHistoryItemCache[itemId] = txtEntry;
                            }
                            winRtEntries.Add(txtEntry);
                            idx++;
                        }
                    }
                    catch { }
                }

                if (winRtEntries.Count > 0)
                {
                    lock (clipboardHistoryLock)
                    {
                        var merged = new List<Dictionary<string, object>>();
                        var seenKeys = new HashSet<string>(StringComparer.Ordinal);
                        foreach (var wEntry in winRtEntries)
                        {
                            string entryType = wEntry.ContainsKey("type") ? Convert.ToString(wEntry["type"]) : "text";
                            string dedupKey = entryType == "image"
                                ? ("img:" + Convert.ToString(wEntry.ContainsKey("imageHash") ? wEntry["imageHash"] : wEntry["id"]))
                                : ("txt:" + Convert.ToString(wEntry["text"]));
                            if (seenKeys.Add(dedupKey))
                                merged.Add(wEntry);
                        }
                        foreach (var oldEntry in clipboardHistory)
                        {
                            string entryType = oldEntry.ContainsKey("type") ? Convert.ToString(oldEntry["type"]) : "text";
                            string t = oldEntry.ContainsKey("text") ? Convert.ToString(oldEntry["text"]) : "";
                            if (t == "Test Windows Copy 12345") continue;
                            string dedupKey = entryType == "image"
                                ? ("img:" + Convert.ToString(oldEntry.ContainsKey("imageHash") ? oldEntry["imageHash"] : oldEntry["id"]))
                                : ("txt:" + t);
                            if (seenKeys.Add(dedupKey) && merged.Count < 40)
                                merged.Add(oldEntry);
                        }
                        clipboardHistory = merged;
                    }
                    SavePersistedClipboardHistory();
                }
            }
            catch { }
        }

        private class GsmtcMediaSnapshot
        {
            public string AppId;
            public string Title;
            public string Artist;
            public bool IsPlaying;
            public double PositionSec;
            public double DurationSec;
            public object SessionObj;
            public bool IsCurrent;
        }

        private static object gsmtcManagerCache = null;
        private static string stickyMediaAppId = "";
        private static string stickyMediaTitle = "";
        private static readonly object mediaSelectLock = new object();

        // The "now playing" item must not jump between apps/tabs when the user pauses (the audio meter goes
        // silent on pause, so picking by loudness flipped titles, durations and the play button). Windows'
        // media session list is the source of truth; the previously shown session stays selected while it exists.
        private static GsmtcMediaSnapshot PickNowPlayingSession(List<GsmtcMediaSnapshot> list)
        {
            if (list == null || list.Count == 0) return null;
            lock (mediaSelectLock)
            {
                GsmtcMediaSnapshot sticky = null, stickyApp = null, current = null, firstPlaying = null;
                foreach (var s in list)
                {
                    if (sticky == null && s.AppId == stickyMediaAppId && s.Title == stickyMediaTitle) sticky = s;
                    if (stickyApp == null && s.AppId == stickyMediaAppId) stickyApp = s;
                    if (current == null && s.IsCurrent) current = s;
                    if (firstPlaying == null && s.IsPlaying) firstPlaying = s;
                }
                GsmtcMediaSnapshot pick;
                var stickyAny = sticky ?? stickyApp;
                if (stickyAny != null && stickyAny.IsPlaying) pick = stickyAny;
                else if (firstPlaying != null) pick = (current != null && current.IsPlaying) ? current : firstPlaying; // something else started playing
                else pick = stickyAny ?? current ?? list[0];
                stickyMediaAppId = pick.AppId;
                stickyMediaTitle = pick.Title;
                return pick;
            }
        }

        private static string FriendlyMediaAppName(string appId)
        {
            string id = appId ?? "";
            int bang = id.LastIndexOf('!');
            if (bang >= 0 && bang < id.Length - 1) id = id.Substring(bang + 1);
            if (id.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) id = id.Substring(0, id.Length - 4);
            // Per-user Chromium installs register as "Name.HASH" (e.g. Helium.2MJ3WA4NM22WZD5M2XCXJVOABA)
            int dot = id.IndexOf('.');
            if (dot > 0 && id.Length - dot - 1 >= 16) id = id.Substring(0, dot);
            string l = id.ToLowerInvariant();
            if (l.Contains("chrome")) return "Google Chrome";
            if (l.Contains("msedge") || l == "microsoftedge") return "Microsoft Edge";
            if (l.Contains("spotify")) return "Spotify";
            if (l.Contains("firefox") || l == "308046b0af4a39cb") return "Firefox";
            if (l.Contains("brave")) return "Brave";
            if (l.Contains("opera")) return "Opera";
            if (l.Contains("vlc")) return "VLC Media Player";
            if (l.Contains("zune") || l.Contains("music")) return "Medya Oynatıcı";
            return string.IsNullOrEmpty(id) ? "PC Medya" : id;
        }

        // Play/pause/next/previous on the exact session the phone is showing (falls back to media keys)
        private static void ExecuteMediaCommand(string key)
        {
            var list = GetGsmtcSessionsSnapshot();
            var pick = PickNowPlayingSession(list);
            if (pick == null || pick.SessionObj == null)
            {
                lastMediaKeySentTick = Environment.TickCount;
                SendKeyCombo(key);
                return;
            }
            string method = key == "MEDIA_NEXT" ? "TrySkipNextAsync" : key == "MEDIA_PREV" ? "TrySkipPreviousAsync" : key == "MEDIA_STOP" ? "TryStopAsync" : "TryTogglePlayPauseAsync";
            bool sent = false;
            try
            {
                MethodInfo mi = pick.SessionObj.GetType().GetMethod(method);
                if (mi != null)
                {
                    object op = mi.Invoke(pick.SessionObj, null);
                    object res = AwaitWinRtOperation(op, typeof(bool), 800);
                    sent = res is bool && (bool)res;
                }
            }
            catch { }
            if (!sent)
            {
                lastMediaKeySentTick = Environment.TickCount;
                SendKeyCombo(key);
                return;
            }
            if (method == "TryTogglePlayPauseAsync")
            {
                // Wait (briefly) until Windows reports the new state so the reply is not stale
                bool before = pick.IsPlaying;
                for (int i = 0; i < 12; i++)
                {
                    Thread.Sleep(40);
                    var again = GetGsmtcSessionsSnapshot();
                    GsmtcMediaSnapshot same = null;
                    foreach (var s in again) { if (s.AppId == pick.AppId && s.Title == pick.Title) { same = s; break; } }
                    if (same == null || same.IsPlaying != before) break;
                }
            }
        }

        private static List<GsmtcMediaSnapshot> GetGsmtcSessionsSnapshot(double? seekPositionSec = null, string targetProcHint = null)
        {
            var result = new List<GsmtcMediaSnapshot>();
            try
            {
                Type gsmtcType = Type.GetType("Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime");
                Type sessType = Type.GetType("Windows.Media.Control.GlobalSystemMediaTransportControlsSession, Windows.Media.Control, ContentType=WindowsRuntime");
                Type tlType = Type.GetType("Windows.Media.Control.GlobalSystemMediaTransportControlsSessionTimelineProperties, Windows.Media.Control, ContentType=WindowsRuntime");
                Type pbType = Type.GetType("Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackInfo, Windows.Media.Control, ContentType=WindowsRuntime");
                Type propsType = Type.GetType("Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime");
                Type boolType = typeof(bool);
                if (gsmtcType == null || sessType == null || tlType == null || pbType == null) return result;

                object mgr = gsmtcManagerCache;
                if (mgr == null)
                {
                    object mgrOp = gsmtcType.GetMethod("RequestAsync").Invoke(null, null);
                    mgr = AwaitWinRtOperation(mgrOp, gsmtcType, 800);
                    if (mgr == null) return result;
                    gsmtcManagerCache = mgr;
                }

                object currentSess = null;
                try { currentSess = gsmtcType.GetMethod("GetCurrentSession").Invoke(mgr, null); } catch { }
                string currentAppId = "";
                try { if (currentSess != null) currentAppId = Convert.ToString(sessType.GetProperty("SourceAppUserModelId").GetValue(currentSess, null) ?? ""); } catch { }

                IEnumerable sessions = gsmtcType.GetMethod("GetSessions").Invoke(mgr, null) as IEnumerable;
                if (sessions == null) return result;

                PropertyInfo appIdProp = sessType.GetProperty("SourceAppUserModelId");
                MethodInfo getTlMethod = sessType.GetMethod("GetTimelineProperties");
                MethodInfo getPbMethod = sessType.GetMethod("GetPlaybackInfo");
                MethodInfo getPropsMethod = sessType.GetMethod("TryGetMediaPropertiesAsync");
                MethodInfo seekMethod = sessType.GetMethod("TryChangePlaybackPositionAsync");

                PropertyInfo posProp = tlType.GetProperty("Position");
                PropertyInfo endProp = tlType.GetProperty("EndTime");
                PropertyInfo updatedProp = tlType.GetProperty("LastUpdatedTime");
                PropertyInfo statusProp = pbType.GetProperty("PlaybackStatus");
                PropertyInfo titleProp = propsType != null ? propsType.GetProperty("Title") : null;
                PropertyInfo artistProp = propsType != null ? propsType.GetProperty("Artist") : null;

                object seekTargetSession = null;
                foreach (object s in sessions)
                {
                    try
                    {
                        string appId = Convert.ToString(appIdProp.GetValue(s, null) ?? "");
                        object tl = getTlMethod.Invoke(s, null);
                        TimeSpan pos = (TimeSpan)posProp.GetValue(tl, null);
                        TimeSpan end = (TimeSpan)endProp.GetValue(tl, null);
                        DateTimeOffset updated = (DateTimeOffset)updatedProp.GetValue(tl, null);

                        object pb = getPbMethod.Invoke(s, null);
                        int pbStatus = Convert.ToInt32(statusProp.GetValue(pb, null));
                        bool isPlaying = (pbStatus == 4); // 4 = Playing, 5 = Paused

                        double durSec = Math.Max(0.0, end.TotalSeconds);
                        double posSec = Math.Max(0.0, pos.TotalSeconds);
                        if (isPlaying && updated.Year > 2020)
                        {
                            double elapsed = (DateTimeOffset.UtcNow - updated).TotalSeconds;
                            if (elapsed > 0 && elapsed < 36000)
                                posSec += elapsed;
                        }
                        if (durSec > 0 && posSec > durSec) posSec = durSec;

                        string title = "";
                        string artist = "";
                        if (propsType != null && getPropsMethod != null)
                        {
                            try
                            {
                                object propsOp = getPropsMethod.Invoke(s, null);
                                object props = AwaitWinRtOperation(propsOp, propsType, 350);
                                if (props != null)
                                {
                                    if (titleProp != null) title = Convert.ToString(titleProp.GetValue(props, null) ?? "").Trim();
                                    if (artistProp != null) artist = Convert.ToString(artistProp.GetValue(props, null) ?? "").Trim();
                                }
                            }
                            catch { }
                        }

                        if (seekPositionSec.HasValue)
                        {
                            if (!string.IsNullOrEmpty(targetProcHint) && appId.IndexOf(targetProcHint, StringComparison.OrdinalIgnoreCase) >= 0)
                            {
                                seekTargetSession = s;
                            }
                            else if (seekTargetSession == null && (isPlaying || s == currentSess))
                            {
                                seekTargetSession = s;
                            }
                        }

                        result.Add(new GsmtcMediaSnapshot
                        {
                            AppId = appId,
                            Title = title,
                            Artist = artist,
                            IsPlaying = isPlaying,
                            PositionSec = Math.Round(posSec, 1),
                            DurationSec = Math.Round(durSec, 1),
                            SessionObj = s,
                            IsCurrent = appId.Length > 0 && appId == currentAppId
                        });
                    }
                    catch { }
                }

                if (seekPositionSec.HasValue && seekMethod != null)
                {
                    if (seekTargetSession == null && currentSess != null) seekTargetSession = currentSess;
                    if (seekTargetSession == null && result.Count > 0) seekTargetSession = result[0].SessionObj;
                    if (seekTargetSession != null)
                    {
                        long ticks = (long)(Math.Max(0.0, seekPositionSec.Value) * 10000000.0);
                        object seekOp = seekMethod.Invoke(seekTargetSession, new object[] { ticks });
                        AwaitWinRtOperation(seekOp, boolType, 500);
                        foreach (var snap in result)
                        {
                            if (snap.SessionObj == seekTargetSession)
                                snap.PositionSec = Math.Round(Math.Max(0.0, seekPositionSec.Value), 1);
                        }
                    }
                }
            }
            catch { }
            return result;
        }

        private static List<Dictionary<string, object>> GetClipboardHistorySnapshot(bool syncWinRt = false)
        {
            if (syncWinRt)
            {
                SyncWinRtClipboardHistory(true);
            }
            lock (clipboardHistoryLock)
            {
                return new List<Dictionary<string, object>>(clipboardHistory);
            }
        }

        private static List<Dictionary<string, object>> GetAudioEndpointsList(IMMDeviceEnumerator enumerator, EDataFlow flow)
        {
            var list = new List<Dictionary<string, object>>();
            if (enumerator == null) return list;
            try
            {
                string defaultId = "";
                try
                {
                    IMMDevice defDev;
                    if (enumerator.GetDefaultAudioEndpoint(flow, ERole.eMultimedia, out defDev) == 0 && defDev != null)
                    {
                        defDev.GetId(out defaultId);
                    }
                }
                catch { }

                IMMDeviceCollection collection;
                // DEVICE_STATE_ACTIVE = 0x00000001
                if (enumerator.EnumAudioEndpoints(flow, 1, out collection) == 0 && collection != null)
                {
                    uint count = 0;
                    collection.GetCount(out count);
                    PROPERTYKEY pkFriendly = new PROPERTYKEY
                    {
                        fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"),
                        pid = 14
                    };

                    for (uint i = 0; i < count; i++)
                    {
                        try
                        {
                            IMMDevice dev;
                            if (collection.Item(i, out dev) == 0 && dev != null)
                            {
                                string devId = "";
                                dev.GetId(out devId);
                                if (string.IsNullOrEmpty(devId)) continue;

                                string friendlyName = "Ses Cihazı " + (i + 1);
                                try
                                {
                                    IPropertyStore store;
                                    if (dev.OpenPropertyStore(0, out store) == 0 && store != null)
                                    {
                                        PROPVARIANT pv;
                                        if (store.GetValue(ref pkFriendly, out pv) == 0)
                                        {
                                            if (pv.vt == 31 && pv.p != IntPtr.Zero)
                                            {
                                                string s = Marshal.PtrToStringUni(pv.p);
                                                if (!string.IsNullOrWhiteSpace(s)) friendlyName = s.Trim();
                                            }
                                            PropVariantClear(ref pv);
                                        }
                                    }
                                }
                                catch { }

                                list.Add(new Dictionary<string, object>
                                {
                                    { "id", devId },
                                    { "name", friendlyName },
                                    { "isDefault", string.Equals(devId, defaultId, StringComparison.OrdinalIgnoreCase) }
                                });
                            }
                        }
                        catch { }
                    }
                }
            }
            catch { }
            return list;
        }

        private static bool SetDefaultAudioDevice(string deviceId)
        {
            if (string.IsNullOrWhiteSpace(deviceId)) return false;
            try
            {
                IPolicyConfig policy = (IPolicyConfig)(new PolicyConfigClientComObject());
                policy.SetDefaultEndpoint(deviceId, ERole.eConsole);
                policy.SetDefaultEndpoint(deviceId, ERole.eMultimedia);
                policy.SetDefaultEndpoint(deviceId, ERole.eCommunications);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static void GetMicrophoneStatus(IMMDeviceEnumerator enumerator, out int micVolume, out bool micMuted, out bool hasMic)
        {
            micVolume = 100;
            micMuted = false;
            hasMic = false;
            if (enumerator == null) return;
            try
            {
                IMMDevice micDev;
                if (enumerator.GetDefaultAudioEndpoint(EDataFlow.eCapture, ERole.eCommunications, out micDev) != 0 || micDev == null)
                {
                    enumerator.GetDefaultAudioEndpoint(EDataFlow.eCapture, ERole.eMultimedia, out micDev);
                }
                if (micDev != null)
                {
                    Guid iidEndpointVol = typeof(IAudioEndpointVolume).GUID;
                    object oVol;
                    if (micDev.Activate(ref iidEndpointVol, 23, IntPtr.Zero, out oVol) == 0 && oVol != null)
                    {
                        IAudioEndpointVolume epVol = (IAudioEndpointVolume)oVol;
                        float v = 1f;
                        bool m = false;
                        epVol.GetMasterVolumeLevelScalar(out v);
                        epVol.GetMute(out m);
                        micVolume = (int)Math.Round(v * 100);
                        micMuted = m;
                        hasMic = true;
                    }
                }
            }
            catch { }
        }

        private static void SetMicrophoneState(IMMDeviceEnumerator enumerator, float? volumeScalar, bool? muted)
        {
            if (enumerator == null) return;
            Guid emptyGuid = Guid.Empty;
            Guid iidEndpointVol = typeof(IAudioEndpointVolume).GUID;
            foreach (ERole role in new[] { ERole.eMultimedia, ERole.eCommunications, ERole.eConsole })
            {
                try
                {
                    IMMDevice micDev;
                    if (enumerator.GetDefaultAudioEndpoint(EDataFlow.eCapture, role, out micDev) == 0 && micDev != null)
                    {
                        object oVol;
                        if (micDev.Activate(ref iidEndpointVol, 23, IntPtr.Zero, out oVol) == 0 && oVol != null)
                        {
                            IAudioEndpointVolume epVol = (IAudioEndpointVolume)oVol;
                            if (volumeScalar.HasValue)
                                epVol.SetMasterVolumeLevelScalar(volumeScalar.Value, ref emptyGuid);
                            if (muted.HasValue)
                                epVol.SetMute(muted.Value, ref emptyGuid);
                        }
                    }
                }
                catch { }
            }
        }

        private static object HandleAudioControl(Dictionary<string, object> args)
        {
            string action = args.ContainsKey("action") ? Convert.ToString(args["action"]) : "get";
            try
            {
                IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());

                if (action == "set_default_device")
                {
                    string targetDevId = args.ContainsKey("deviceId") ? Convert.ToString(args["deviceId"]).Trim() : "";
                    if (!string.IsNullOrEmpty(targetDevId))
                    {
                        SetDefaultAudioDevice(targetDevId);
                    }
                }
                else if (action == "set_mic_mute" || action == "set_mic")
                {
                    float? micVolVal = null;
                    bool? micMuteVal = null;
                    if (args.ContainsKey("volume"))
                    {
                        micVolVal = Math.Max(0f, Math.Min(100f, Convert.ToSingle(args["volume"]))) / 100f;
                    }
                    if (args.ContainsKey("muted"))
                    {
                        micMuteVal = Convert.ToBoolean(args["muted"]);
                    }
                    else if (action == "set_mic_mute")
                    {
                        int curMicVol;
                        bool curMicMuted, curHasMic;
                        GetMicrophoneStatus(enumerator, out curMicVol, out curMicMuted, out curHasMic);
                        micMuteVal = !curMicMuted;
                    }
                    SetMicrophoneState(enumerator, micVolVal, micMuteVal);
                }

                IMMDevice device;
                enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out device);

                Guid iidEndpointVol = typeof(IAudioEndpointVolume).GUID;
                object oVol;
                device.Activate(ref iidEndpointVol, 23, IntPtr.Zero, out oVol);
                IAudioEndpointVolume masterVol = (IAudioEndpointVolume)oVol;

                Guid iidSessionMgr = typeof(IAudioSessionManager2).GUID;
                object oMgr;
                device.Activate(ref iidSessionMgr, 23, IntPtr.Zero, out oMgr);
                IAudioSessionManager2 sessionMgr = (IAudioSessionManager2)oMgr;

                Guid emptyGuid = Guid.Empty;

                if (action == "media_command")
                {
                    string mk = args.ContainsKey("key") ? Convert.ToString(args["key"]).ToUpperInvariant() : "MEDIA_PLAY_PAUSE";
                    ExecuteMediaCommand(mk);
                }
                else if (action == "seek")
                {
                    double targetSec = args.ContainsKey("positionSec")
                        ? Convert.ToDouble(args["positionSec"])
                        : (args.ContainsKey("position") ? Convert.ToDouble(args["position"]) : 0.0);
                    string procHint = args.ContainsKey("processName") ? Convert.ToString(args["processName"]) : "";
                    if (string.IsNullOrEmpty(procHint))
                    {
                        lock (mediaSelectLock) { procHint = stickyMediaAppId; }
                    }
                    GetGsmtcSessionsSnapshot(targetSec, procHint);
                }
                else if (action == "set_master")
                {
                    if (args.ContainsKey("volume"))
                    {
                        float v = Math.Max(0f, Math.Min(100f, Convert.ToSingle(args["volume"]))) / 100f;
                        masterVol.SetMasterVolumeLevelScalar(v, ref emptyGuid);
                    }
                    if (args.ContainsKey("muted"))
                    {
                        bool m = Convert.ToBoolean(args["muted"]);
                        masterVol.SetMute(m, ref emptyGuid);
                    }
                }
                else if (action == "set_app")
                {
                    uint targetPid = args.ContainsKey("pid") ? Convert.ToUInt32(args["pid"]) : 0;
                    string targetProc = args.ContainsKey("processName") ? Convert.ToString(args["processName"]) : "";

                    IAudioSessionEnumerator sessionEnum;
                    sessionMgr.GetSessionEnumerator(out sessionEnum);
                    int count;
                    sessionEnum.GetCount(out count);

                    for (int i = 0; i < count; i++)
                    {
                        IAudioSessionControl2 ctl;
                        sessionEnum.GetSession(i, out ctl);
                        uint pid;
                        ctl.GetProcessId(out pid);
                        if (pid == 0) continue;

                        bool match = (targetPid != 0 && pid == targetPid);
                        if (!match && !string.IsNullOrEmpty(targetProc))
                        {
                            try
                            {
                                Process p = Process.GetProcessById((int)pid);
                                if (p.ProcessName.Equals(targetProc, StringComparison.OrdinalIgnoreCase))
                                    match = true;
                            }
                            catch { }
                        }

                        if (match)
                        {
                            ISimpleAudioVolume simpleVol = ctl as ISimpleAudioVolume;
                            if (simpleVol != null)
                            {
                                if (args.ContainsKey("volume"))
                                {
                                    float v = Math.Max(0f, Math.Min(100f, Convert.ToSingle(args["volume"]))) / 100f;
                                    simpleVol.SetMasterVolume(v, ref emptyGuid);
                                }
                                if (args.ContainsKey("muted"))
                                {
                                    simpleVol.SetMute(Convert.ToBoolean(args["muted"]), ref emptyGuid);
                                }
                            }
                        }
                    }
                }

                // Read current state
                float currentMaster = 0f;
                bool currentMuted = false;
                masterVol.GetMasterVolumeLevelScalar(out currentMaster);
                masterVol.GetMute(out currentMuted);

                var sessions = new List<Dictionary<string, object>>();
                var seenProcs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                IAudioSessionEnumerator sEnum;
                sessionMgr.GetSessionEnumerator(out sEnum);
                int sCount;
                sEnum.GetCount(out sCount);

                var openWins = GetOpenWindows();
                var winByProc = new Dictionary<string, Dictionary<string, object>>(StringComparer.OrdinalIgnoreCase);
                foreach (var w in openWins)
                {
                    string wp = Convert.ToString(w["processName"] ?? "");
                    string rawWp = w.ContainsKey("rawProcessName") ? Convert.ToString(w["rawProcessName"] ?? "") : "";
                    if (!string.IsNullOrEmpty(wp) && !winByProc.ContainsKey(wp))
                        winByProc[wp] = w;
                    if (!string.IsNullOrEmpty(rawWp) && !winByProc.ContainsKey(rawWp))
                        winByProc[rawWp] = w;
                }

                Dictionary<string, object> bestAudibleCandidate = null;
                int bestAudibleScore = -1;
                Dictionary<string, object> bestPausedMediaAppCandidate = null;
                int bestPausedMediaAppScore = -1;
                long nowTick = Environment.TickCount;

                for (int i = 0; i < sCount; i++)
                {
                    IAudioSessionControl2 ctl;
                    sEnum.GetSession(i, out ctl);
                    uint pid;
                    ctl.GetProcessId(out pid);
                    if (pid == 0) continue;

                    string procName = "";
                    string procMainTitle = "";
                    string procExe = "";
                    try
                    {
                        Process p = Process.GetProcessById((int)pid);
                        procName = p.ProcessName;
                        try { procMainTitle = p.MainWindowTitle ?? ""; } catch { }
                        try { procExe = p.MainModule.FileName ?? ""; } catch { }
                    }
                    catch { continue; }

                    if (string.IsNullOrEmpty(procName)) continue;
                    if (procName.Equals("svchost", StringComparison.OrdinalIgnoreCase) ||
                        procName.Equals("nvcontainer", StringComparison.OrdinalIgnoreCase) ||
                        procName.Equals("SearchHost", StringComparison.OrdinalIgnoreCase) ||
                        procName.Equals("ShellExperienceHost", StringComparison.OrdinalIgnoreCase)) continue;

                    int sessionState = 0;
                    try { ctl.GetState(out sessionState); } catch { }

                    float sv = 1f;
                    bool sm = false;
                    ISimpleAudioVolume sVol = ctl as ISimpleAudioVolume;
                    if (sVol != null)
                    {
                        try
                        {
                            sVol.GetMasterVolume(out sv);
                            sVol.GetMute(out sm);
                        }
                        catch { }
                    }

                    float peak = 0f;
                    try
                    {
                        IAudioMeterInformation meter = ctl as IAudioMeterInformation;
                        if (meter != null)
                        {
                            meter.GetPeakValue(out peak);
                            if (peak <= 0.00025f && sessionState == 1)
                            {
                                for (int s = 0; s < 2; s++)
                                {
                                    Thread.Sleep(10);
                                    float pSample = 0f;
                                    meter.GetPeakValue(out pSample);
                                    if (pSample > peak) peak = pSample;
                                    if (peak > 0.00025f) break;
                                }
                            }
                        }
                    }
                    catch { }

                    string winTitle = procMainTitle;
                    string iconB64 = "";
                    string displayProcName = procName;
                    if (winByProc.ContainsKey(procName))
                    {
                        var matchedWin = winByProc[procName];
                        displayProcName = Convert.ToString(matchedWin["processName"] ?? procName);
                        if (string.IsNullOrEmpty(winTitle))
                            winTitle = Convert.ToString(matchedWin["title"] ?? "");
                        iconB64 = Convert.ToString(matchedWin["icon"] ?? "");
                        if (string.IsNullOrEmpty(procExe))
                            procExe = Convert.ToString(matchedWin["exePath"] ?? "");
                    }
                    if (string.IsNullOrEmpty(iconB64) && !string.IsNullOrEmpty(procExe))
                    {
                        iconB64 = GetAppIconBase64(procExe);
                    }

                    string cleanTitle = string.IsNullOrWhiteSpace(winTitle) ? displayProcName : winTitle.Trim();
                    string[] suffixes = new[] { " - YouTube", " - Google Chrome", " - Helium", " - Microsoft​ Edge", " - Microsoft Edge", " - Brave", " - Mozilla Firefox", " - Zen Browser", " - VLC media player" };
                    foreach (var suf in suffixes)
                    {
                        if (cleanTitle.EndsWith(suf, StringComparison.OrdinalIgnoreCase))
                        {
                            cleanTitle = cleanTitle.Substring(0, cleanTitle.Length - suf.Length).Trim();
                        }
                    }

                    // Track title transitions (e.g., Spotify/YouTube advancing to the next song)
                    if (!string.IsNullOrEmpty(cleanTitle))
                    {
                        string prevT;
                        if (lastTitleByPid.TryGetValue(pid, out prevT) && !string.Equals(prevT, cleanTitle, StringComparison.Ordinal))
                        {
                            lastTitleChangeTickByPid[pid] = nowTick;
                        }
                        lastTitleByPid[pid] = cleanTitle;
                    }

                    bool isRawAudible = !currentMuted && !sm && (peak > 0.00025f);
                    if (isRawAudible)
                    {
                        lastAudibleTickByPid[pid] = nowTick;
                    }

                    // Smart hysteresis: prevent false "Paused" flickers during track changes (<1200ms after title change)
                    // or brief <550ms micro-silences between words, while reacting immediately when paused on PC or phone
                    bool isEffectivePlaying = isRawAudible;
                    if (!isEffectivePlaying && sessionState == 1 && !currentMuted && !sm && Math.Abs(nowTick - lastMediaKeySentTick) > 900)
                    {
                        long lastAudTick;
                        if (lastAudibleTickByPid.TryGetValue(pid, out lastAudTick))
                        {
                            long silenceMs = Math.Abs(nowTick - lastAudTick);
                            long titleChangeTick;
                            bool inTrackTransition = lastTitleChangeTickByPid.TryGetValue(pid, out titleChangeTick) && Math.Abs(nowTick - titleChangeTick) < 1250;
                            if (silenceMs < 550 || (inTrackTransition && silenceMs < 1350))
                            {
                                isEffectivePlaying = true;
                            }
                        }
                    }

                    bool isKnownMediaApp =
                        procName.Equals("Spotify", StringComparison.OrdinalIgnoreCase) ||
                        procName.Equals("chrome", StringComparison.OrdinalIgnoreCase) ||
                        procName.Equals("helium", StringComparison.OrdinalIgnoreCase) ||
                        procName.Equals("msedge", StringComparison.OrdinalIgnoreCase) ||
                        procName.Equals("brave", StringComparison.OrdinalIgnoreCase) ||
                        procName.Equals("firefox", StringComparison.OrdinalIgnoreCase) ||
                        procName.Equals("opera", StringComparison.OrdinalIgnoreCase) ||
                        procName.Equals("zen", StringComparison.OrdinalIgnoreCase) ||
                        procName.Equals("vlc", StringComparison.OrdinalIgnoreCase) ||
                        procName.Equals("mpc-hc64", StringComparison.OrdinalIgnoreCase) ||
                        procName.Equals("Music.UI", StringComparison.OrdinalIgnoreCase) ||
                        procName.Equals("foobar2000", StringComparison.OrdinalIgnoreCase) ||
                        procName.Equals("AIMP", StringComparison.OrdinalIgnoreCase);

                    bool isExcludedFromNowPlaying =
                        procName.Equals("Discord", StringComparison.OrdinalIgnoreCase) ||
                        procName.IndexOf("SteelSeries", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        procName.IndexOf("Sonar", StringComparison.OrdinalIgnoreCase) >= 0 ||
                        procName.Equals("steamwebhelper", StringComparison.OrdinalIgnoreCase) ||
                        procName.Equals("steam", StringComparison.OrdinalIgnoreCase) ||
                        procName.Equals("explorer", StringComparison.OrdinalIgnoreCase);

                    string friendlyApp = displayProcName;
                    if (procName.Equals("chrome", StringComparison.OrdinalIgnoreCase)) friendlyApp = "Google Chrome";
                    else if (procName.Equals("helium", StringComparison.OrdinalIgnoreCase)) friendlyApp = "Helium";
                    else if (procName.Equals("msedge", StringComparison.OrdinalIgnoreCase)) friendlyApp = "Microsoft Edge";
                    else if (procName.Equals("brave", StringComparison.OrdinalIgnoreCase)) friendlyApp = "Brave";
                    else if (procName.Equals("zen", StringComparison.OrdinalIgnoreCase)) friendlyApp = "Zen Browser";
                    else if (procName.Equals("vlc", StringComparison.OrdinalIgnoreCase)) friendlyApp = "VLC Media Player";

                    if (!isExcludedFromNowPlaying)
                    {
                        var candidateObj = new Dictionary<string, object>
                        {
                            { "active", true },
                            { "isPlaying", isEffectivePlaying },
                            { "title", string.IsNullOrWhiteSpace(cleanTitle) ? friendlyApp : cleanTitle },
                            { "appName", friendlyApp },
                            { "processName", procName },
                            { "pid", pid },
                            { "icon", iconB64 }
                        };

                        if (isEffectivePlaying)
                        {
                            int score = 100;
                            if (procName.Equals("Spotify", StringComparison.OrdinalIgnoreCase) ||
                                procName.Equals("vlc", StringComparison.OrdinalIgnoreCase)) score += 45;
                            else if (isKnownMediaApp) score += 30;
                            if (!string.IsNullOrWhiteSpace(winTitle)) score += 15;

                            if (score > bestAudibleScore)
                            {
                                bestAudibleScore = score;
                                bestAudibleCandidate = candidateObj;
                            }
                        }
                        else if (isKnownMediaApp && !string.IsNullOrWhiteSpace(winTitle))
                        {
                            int pScore = (sessionState == 1 ? 30 : 10) + (procName.Equals("Spotify", StringComparison.OrdinalIgnoreCase) ? 20 : 10);
                            if (lastKnownMediaCandidate != null &&
                                string.Equals(Convert.ToString(lastKnownMediaCandidate["processName"]), procName, StringComparison.OrdinalIgnoreCase))
                            {
                                pScore += 100; // Strongly prefer the previously active media player when paused!
                            }
                            if (pScore > bestPausedMediaAppScore)
                            {
                                bestPausedMediaAppScore = pScore;
                                bestPausedMediaAppCandidate = candidateObj;
                            }
                        }
                    }

                    if (!seenProcs.Contains(displayProcName) && sVol != null)
                    {
                        seenProcs.Add(displayProcName);
                        sessions.Add(new Dictionary<string, object>
                        {
                            { "pid", pid },
                            { "processName", displayProcName },
                            { "rawProcessName", procName },
                            { "icon", iconB64 },
                            { "volume", (int)Math.Round(sv * 100) },
                            { "muted", sm },
                            { "isActive", isEffectivePlaying }
                        });
                    }
                }

                Dictionary<string, object> finalMedia = null;
                if (bestAudibleCandidate != null)
                {
                    finalMedia = bestAudibleCandidate;
                    lastKnownMediaCandidate = new Dictionary<string, object>(bestAudibleCandidate);
                }
                else if (bestPausedMediaAppCandidate != null)
                {
                    finalMedia = bestPausedMediaAppCandidate;
                    finalMedia["isPlaying"] = false;
                    lastKnownMediaCandidate = new Dictionary<string, object>(finalMedia);
                }
                else if (lastKnownMediaCandidate != null)
                {
                    string prevProc = Convert.ToString(lastKnownMediaCandidate["processName"] ?? "");
                    if (!string.IsNullOrEmpty(prevProc) && Process.GetProcessesByName(prevProc).Length > 0)
                    {
                        finalMedia = new Dictionary<string, object>(lastKnownMediaCandidate);
                        finalMedia["active"] = true;
                        finalMedia["isPlaying"] = false;
                    }
                    else
                    {
                        lastKnownMediaCandidate = null;
                    }
                }

                if (finalMedia == null)
                {
                    finalMedia = new Dictionary<string, object>
                    {
                        { "active", false },
                        { "isPlaying", false },
                        { "title", "Medya Oynatılmıyor" },
                        { "appName", "Masaüstü Ses Sistemi" },
                        { "processName", "" },
                        { "pid", 0 },
                        { "icon", "" },
                        { "positionSec", 0.0 },
                        { "durationSec", 0.0 }
                    };
                }

                // Windows media sessions (GSMTC) are authoritative: title, play state and timeline all come from
                // the same session, so pausing never swaps in another app's duration or position.
                try
                {
                    var pick = PickNowPlayingSession(GetGsmtcSessionsSnapshot());
                    if (pick != null)
                    {
                        string songTitle = pick.Title ?? "";
                        if (!string.IsNullOrEmpty(pick.Artist) && songTitle.IndexOf(pick.Artist, StringComparison.OrdinalIgnoreCase) < 0)
                            songTitle = string.IsNullOrEmpty(songTitle) ? pick.Artist : pick.Artist + " - " + songTitle;
                        string appFriendly = FriendlyMediaAppName(pick.AppId);

                        Dictionary<string, object> audioMatch = null;
                        foreach (var sess in sessions)
                        {
                            string raw = Convert.ToString(sess["rawProcessName"] ?? "");
                            if (raw.Length > 0 && (pick.AppId.IndexOf(raw, StringComparison.OrdinalIgnoreCase) >= 0 ||
                                appFriendly.IndexOf(raw, StringComparison.OrdinalIgnoreCase) >= 0)) { audioMatch = sess; break; }
                        }

                        finalMedia = new Dictionary<string, object>
                        {
                            { "active", true },
                            { "isPlaying", pick.IsPlaying },
                            { "title", string.IsNullOrWhiteSpace(songTitle) ? appFriendly : songTitle },
                            { "appName", appFriendly },
                            { "processName", audioMatch != null ? Convert.ToString(audioMatch["rawProcessName"]) : appFriendly },
                            { "pid", audioMatch != null ? audioMatch["pid"] : (object)0 },
                            { "icon", audioMatch != null ? audioMatch["icon"] : (object)"" },
                            { "sourceAppId", pick.AppId },
                            { "positionSec", pick.PositionSec },
                            { "durationSec", pick.DurationSec }
                        };
                    }
                }
                catch { }
                if (!finalMedia.ContainsKey("positionSec")) finalMedia["positionSec"] = 0.0;
                if (!finalMedia.ContainsKey("durationSec")) finalMedia["durationSec"] = 0.0;

                int micVol = 100;
                bool micMuted = false;
                bool hasMic = false;
                GetMicrophoneStatus(enumerator, out micVol, out micMuted, out hasMic);
                var outputDevices = GetAudioEndpointsList(enumerator, EDataFlow.eRender);
                var inputDevices = GetAudioEndpointsList(enumerator, EDataFlow.eCapture);

                return new
                {
                    masterVolume = (int)Math.Round(currentMaster * 100),
                    masterMuted = currentMuted,
                    micVolume = micVol,
                    micMuted = micMuted,
                    hasMic = hasMic,
                    outputDevices = outputDevices,
                    inputDevices = inputDevices,
                    sessions = sessions,
                    nowPlaying = finalMedia
                };
            }
            catch (Exception ex)
            {
                return new { masterVolume = 50, masterMuted = false, micVolume = 100, micMuted = false, hasMic = false, outputDevices = new object[0], inputDevices = new object[0], sessions = new object[0], nowPlaying = new { active = false, isPlaying = false, title = "Medya Oynatılmıyor", appName = "PC", positionSec = 0.0, durationSec = 0.0 }, warning = ex.Message };
            }
        }

        private static int currentBrightnessLevel = 100;

        private static void SetMonitorBrightnessLevel(int monitorIndex, int level)
        {
            int clamped = Math.Max(10, Math.Min(100, level));

            var monitors = GetMonitorsList();
            lock (monitorBrightnessMap)
            {
                if (monitorIndex < 0)
                {
                    currentBrightnessLevel = clamped;
                    for (int i = 0; i < Math.Max(1, monitors.Count); i++)
                        monitorBrightnessMap[i] = clamped;
                }
                else
                {
                    // Ensure all other monitors have their own explicit default entry so they don't inherit
                    for (int i = 0; i < Math.Max(1, monitors.Count); i++)
                    {
                        if (!monitorBrightnessMap.ContainsKey(i))
                            monitorBrightnessMap[i] = currentBrightnessLevel;
                    }
                    monitorBrightnessMap[monitorIndex] = clamped;
                }
            }

            if (uiDispatcherForm != null && uiDispatcherForm.IsHandleCreated)
            {
                try
                {
                    uiDispatcherForm.BeginInvoke((MethodInvoker)delegate
                    {
                        try
                        {
                            var currentMons = GetMonitorsList();
                            lock (dimmerForms)
                            {
                                foreach (var m in currentMons)
                                {
                                    if (monitorIndex >= 0 && m.index != monitorIndex) continue;
                                    int mLevel = clamped;
                                    lock (monitorBrightnessMap)
                                    {
                                        if (monitorBrightnessMap.ContainsKey(m.index))
                                            mLevel = monitorBrightnessMap[m.index];
                                    }

                                    if (mLevel >= 100)
                                    {
                                        if (dimmerForms.ContainsKey(m.index) && dimmerForms[m.index] != null)
                                        {
                                            try
                                            {
                                                dimmerForms[m.index].Hide();
                                                dimmerForms[m.index].Close();
                                            }
                                            catch { }
                                            dimmerForms.Remove(m.index);
                                        }
                                    }
                                    else
                                    {
                                        double targetOpacity = Math.Max(0.0, Math.Min(0.86, (100 - mLevel) * 0.86 / 90.0));
                                        Form df = null;
                                        if (dimmerForms.ContainsKey(m.index))
                                            df = dimmerForms[m.index];

                                        if (df == null || df.IsDisposed)
                                        {
                                            df = new ClickThroughDimmerForm
                                            {
                                                FormBorderStyle = FormBorderStyle.None,
                                                StartPosition = FormStartPosition.Manual,
                                                BackColor = Color.Black,
                                                Bounds = new Rectangle(m.x, m.y, m.width, m.height),
                                                TopMost = true,
                                                ShowInTaskbar = false,
                                                Opacity = targetOpacity
                                            };
                                            df.Show();
                                            int exStyle = GetWindowLong(df.Handle, GWL_EXSTYLE);
                                            SetWindowLong(df.Handle, GWL_EXSTYLE, exStyle | WS_EX_LAYERED | 0x00000020 | 0x00000080 | 0x08000000);
                                            SetWindowPos(df.Handle, HWND_TOPMOST, m.x, m.y, m.width, m.height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
                                            dimmerForms[m.index] = df;
                                        }
                                        else
                                        {
                                            df.Bounds = new Rectangle(m.x, m.y, m.width, m.height);
                                            df.Opacity = targetOpacity;
                                            if (!df.Visible) df.Show();
                                            SetWindowPos(df.Handle, HWND_TOPMOST, m.x, m.y, m.width, m.height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
                                        }
                                    }
                                }
                            }
                        }
                        catch { }
                    });
                }
                catch { }
            }

            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = "powershell.exe",
                        Arguments = "-NoProfile -WindowStyle Hidden -Command \"(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue) | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName WmiSetBrightness -Arguments @{Timeout=1; Brightness=" + clamped + "} | Out-Null }\"",
                        CreateNoWindow = true,
                        UseShellExecute = false
                    });
                }
                catch { }
            });
        }

        private static object HandleSystemControl(Dictionary<string, object> args)
        {
            string action = args.ContainsKey("action") ? Convert.ToString(args["action"]) : "stats";
            switch (action)
            {
                case "lock":
                    SetPcLockState(true);
                    return new { ok = true, action = "lock", isLocked = true };
                case "unlock":
                    SetPcLockState(false);
                    return new { ok = true, action = "unlock", isLocked = false };
                case "toggle_lock":
                    SetPcLockState(!isPcLocked);
                    return new { ok = true, action = isPcLocked ? "lock" : "unlock", isLocked = isPcLocked };
                case "sleep":
                    ThreadPool.QueueUserWorkItem(_ => { Thread.Sleep(100); SetSuspendState(false, false, false); });
                    return new { ok = true, action = "sleep" };
                case "hibernate":
                    ThreadPool.QueueUserWorkItem(_ => { Thread.Sleep(100); SetSuspendState(true, false, false); });
                    return new { ok = true, action = "hibernate" };
                case "shutdown":
                    Process.Start(new ProcessStartInfo("shutdown.exe", "/s /t 0") { CreateNoWindow = true, UseShellExecute = false });
                    return new { ok = true, action = "shutdown" };
                case "restart":
                    Process.Start(new ProcessStartInfo("shutdown.exe", "/r /t 0") { CreateNoWindow = true, UseShellExecute = false });
                    return new { ok = true, action = "restart" };
                case "show_desktop":
                    SendKeyCombo("WIN+D");
                    ReassertMonitorsOffIfNeeded();
                    return new { ok = true, action = "show_desktop" };
                case "task_manager":
                    SendKeyCombo("CTRL+SHIFT+ESC");
                    ReassertMonitorsOffIfNeeded();
                    return new { ok = true, action = "task_manager" };
                case "media_key":
                    string mKey = args.ContainsKey("key") ? Convert.ToString(args["key"]).ToUpperInvariant() : "MEDIA_PLAY_PAUSE";
                    ExecuteMediaCommand(mKey);
                    ReassertMonitorsOffIfNeeded();
                    return new { ok = true, key = mKey };
                case "set_brightness":
                    int bVal = args.ContainsKey("brightness")
                        ? Convert.ToInt32(args["brightness"])
                        : (args.ContainsKey("level") ? Convert.ToInt32(args["level"]) : 100);
                    int bMonIdx = args.ContainsKey("monitorIndex") ? Convert.ToInt32(args["monitorIndex"]) : -1;
                    SetMonitorBrightnessLevel(bMonIdx, bVal);
                    return new { ok = true, monitorIndex = bMonIdx, brightness = bVal, monitors = GetMonitorsList() };
                case "empty_recycle_bin":
                    try { SHEmptyRecycleBin(IntPtr.Zero, null, 0x0001 | 0x0002 | 0x0004); } catch { }
                    ReassertMonitorsOffIfNeeded();
                    return new { ok = true, action = "empty_recycle_bin" };
                case "optimize_memory":
                    int trimmedCount = 0;
                    try
                    {
                        foreach (var p in Process.GetProcesses())
                        {
                            try
                            {
                                if (p.Id > 4 && EmptyWorkingSet(p.Handle))
                                    trimmedCount++;
                            }
                            catch { }
                        }
                    }
                    catch { }
                    return new { ok = true, trimmedProcesses = trimmedCount };
                case "open_url":
                    string url = args.ContainsKey("url") ? Convert.ToString(args["url"]).Trim() : "";
                    if (!string.IsNullOrEmpty(url))
                    {
                        if (!url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
                            !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                        {
                            url = "https://" + url;
                        }
                        int dummyPid;
                        if (!IsRunningAsSystemAccount() || !TryStartProcessInActiveUserSession("explorer.exe", "\"" + url + "\"", null, "normal", out dummyPid))
                        {
                            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                        }
                    }
                    return new { ok = true, url = url };
                case "get_clipboard":
                    string clipText = "";
                    if (uiDispatcherForm != null && uiDispatcherForm.IsHandleCreated)
                    {
                        uiDispatcherForm.Invoke((MethodInvoker)delegate
                        {
                            try
                            {
                                clipText = GetCurrentClipboardTextSafe();
                                if (string.IsNullOrWhiteSpace(clipText) && Clipboard.ContainsText())
                                {
                                    clipText = Clipboard.GetText();
                                }
                                if (!string.IsNullOrWhiteSpace(clipText))
                                    AddClipboardHistoryEntry(clipText);
                            }
                            catch { }
                        });
                    }
                    else
                    {
                        clipText = GetCurrentClipboardTextSafe() ?? "";
                        if (!string.IsNullOrWhiteSpace(clipText)) AddClipboardHistoryEntry(clipText);
                    }
                    if (string.IsNullOrWhiteSpace(clipText))
                    {
                        lock (clipboardHistoryLock)
                        {
                            if (clipboardHistory.Count > 0)
                            {
                                clipText = Convert.ToString(clipboardHistory[0]["text"] ?? "");
                            }
                        }
                    }
                    return new { text = clipText, history = GetClipboardHistorySnapshot() };
                case "get_clipboard_history":
                    if (uiDispatcherForm != null && uiDispatcherForm.IsHandleCreated)
                    {
                        try { uiDispatcherForm.Invoke((MethodInvoker)delegate { PollClipboardHistoryOnSta(); }); } catch { }
                    }
                    else
                    {
                        string ctxt = GetCurrentClipboardTextSafe();
                        if (!string.IsNullOrWhiteSpace(ctxt)) AddClipboardHistoryEntry(ctxt);
                    }
                    var clipHist = GetClipboardHistorySnapshot(true);
                    return new { items = clipHist, history = clipHist };
                case "clear_clipboard_history":
                    lock (clipboardHistoryLock)
                    {
                        clipboardHistory.Clear();
                    }
                    lock (winRtHistoryItemCache)
                    {
                        winRtHistoryItemCache.Clear();
                    }
                    try
                    {
                        Type clipType = Type.GetType("Windows.ApplicationModel.DataTransfer.Clipboard, Windows.ApplicationModel.DataTransfer, ContentType=WindowsRuntime");
                        if (clipType != null)
                        {
                            MethodInfo clearHist = clipType.GetMethod("ClearHistory", Type.EmptyTypes);
                            if (clearHist != null) clearHist.Invoke(null, null);
                        }
                    }
                    catch { }
                    SavePersistedClipboardHistory();
                    return new { ok = true, history = GetClipboardHistorySnapshot() };
                case "set_clipboard":
                    string newText = args.ContainsKey("text") ? Convert.ToString(args["text"]) : "";
                    if (uiDispatcherForm != null && uiDispatcherForm.IsHandleCreated)
                    {
                        uiDispatcherForm.Invoke((MethodInvoker)delegate
                        {
                            try
                            {
                                Clipboard.SetText(newText);
                                lastSeenClipboardText = newText.Trim();
                                AddClipboardHistoryEntry(newText);
                            }
                            catch { }
                        });
                    }
                    return new { ok = true, history = GetClipboardHistorySnapshot() };
                case "set_clipboard_image":
                    string imgDataUrl = args.ContainsKey("image") ? Convert.ToString(args["image"]) : "";
                    if (!string.IsNullOrEmpty(imgDataUrl) && uiDispatcherForm != null && uiDispatcherForm.IsHandleCreated)
                    {
                        uiDispatcherForm.Invoke((MethodInvoker)delegate
                        {
                            try
                            {
                                int commaIdx = imgDataUrl.IndexOf(',');
                                string b64 = commaIdx >= 0 ? imgDataUrl.Substring(commaIdx + 1) : imgDataUrl;
                                byte[] imgBytes = Convert.FromBase64String(b64);
                                using (MemoryStream ms = new MemoryStream(imgBytes))
                                using (Image img = Image.FromStream(ms))
                                {
                                    Clipboard.SetImage(img);
                                }
                            }
                            catch { }
                        });
                    }
                    return new { ok = true };
                case "get_processes":
                    return new { ok = true, processes = GetTopProcessesList() };
                case "kill_process":
                    return KillProcessCommand(args);
                default:
                    float cpu = 0f;
                    try { if (cpuCounter != null) cpu = cpuCounter.NextValue(); } catch { }
                    int memPct = 0;
                    double usedRamGb = 0.0;
                    double totalRamGb = 0.0;
                    try
                    {
                        MEMORYSTATUSEX mem = new MEMORYSTATUSEX();
                        if (GlobalMemoryStatusEx(mem))
                        {
                            memPct = (int)mem.dwMemoryLoad;
                            totalRamGb = Math.Round((double)mem.ullTotalPhys / (1024.0 * 1024.0 * 1024.0), 1);
                            usedRamGb = Math.Round((double)(mem.ullTotalPhys - mem.ullAvailPhys) / (1024.0 * 1024.0 * 1024.0), 1);
                        }
                    }
                    catch { }
                    return new
                    {
                        machineName = Environment.MachineName,
                        userName = Environment.UserName,
                        cpuPercent = (int)Math.Round(cpu),
                        memoryPercent = memPct,
                        usedRamGb = usedRamGb,
                        totalRamGb = totalRamGb,
                        uptimeSeconds = Environment.TickCount / 1000,
                        isLocked = isPcLocked,
                        brightness = currentBrightnessLevel,
                        battery = GetBatteryStatusSnapshot(),
                        disks = GetDisksUsageSnapshot()
                    };
            }
        }

        private static object GetBatteryStatusSnapshot()
        {
            try
            {
                PowerStatus ps = SystemInformation.PowerStatus;
                bool noBatt = (ps.BatteryChargeStatus & BatteryChargeStatus.NoSystemBattery) != 0 || ps.BatteryChargeStatus == BatteryChargeStatus.Unknown;
                int pct = (int)Math.Round(Math.Max(0.0, Math.Min(1.0, (double)ps.BatteryLifePercent)) * 100.0);
                bool charging = ps.PowerLineStatus == PowerLineStatus.Online || (ps.BatteryChargeStatus & BatteryChargeStatus.Charging) != 0;
                return new
                {
                    hasBattery = !noBatt && ps.BatteryLifePercent <= 1.0f,
                    percent = pct,
                    isCharging = charging,
                    acOnline = ps.PowerLineStatus == PowerLineStatus.Online,
                    remainingSeconds = ps.BatteryLifeRemaining > 0 ? ps.BatteryLifeRemaining : -1
                };
            }
            catch
            {
                return new { hasBattery = false, percent = 100, isCharging = true, acOnline = true, remainingSeconds = -1 };
            }
        }

        private static List<Dictionary<string, object>> cachedDisksList = null;
        private static long lastDisksCheckTick = 0;

        private static List<Dictionary<string, object>> GetDisksUsageSnapshot()
        {
            long now = Environment.TickCount;
            if (cachedDisksList != null && Math.Abs(now - lastDisksCheckTick) < 12000)
            {
                return cachedDisksList;
            }
            var list = new List<Dictionary<string, object>>();
            try
            {
                foreach (DriveInfo d in DriveInfo.GetDrives())
                {
                    try
                    {
                        if (!d.IsReady || (d.DriveType != DriveType.Fixed && d.DriveType != DriveType.Removable)) continue;
                        double totalGb = Math.Round((double)d.TotalSize / (1024.0 * 1024.0 * 1024.0), 1);
                        double freeGb = Math.Round((double)d.AvailableFreeSpace / (1024.0 * 1024.0 * 1024.0), 1);
                        double usedGb = Math.Max(0.0, Math.Round(totalGb - freeGb, 1));
                        int usedPct = totalGb > 0 ? (int)Math.Round((usedGb / totalGb) * 100.0) : 0;
                        string label = "";
                        try { label = d.VolumeLabel ?? ""; } catch { }
                        list.Add(new Dictionary<string, object>
                        {
                            { "name", d.Name.TrimEnd('\\') },
                            { "label", label },
                            { "totalGb", totalGb },
                            { "freeGb", freeGb },
                            { "usedGb", usedGb },
                            { "usedPercent", usedPct }
                        });
                    }
                    catch { }
                }
            }
            catch { }
            cachedDisksList = list;
            lastDisksCheckTick = now;
            return list;
        }

        private static List<Dictionary<string, object>> GetTopProcessesList()
        {
            var result = new List<Dictionary<string, object>>();
            try
            {
                int selfPid = Process.GetCurrentProcess().Id;
                var procs = Process.GetProcesses();
                var candidates = new List<Dictionary<string, object>>();

                foreach (var p in procs)
                {
                    try
                    {
                        if (p.Id <= 4 || p.Id == selfPid) continue;
                        string pName = p.ProcessName ?? "";
                        if (string.IsNullOrEmpty(pName)) continue;
                        if (pName.Equals("svchost", StringComparison.OrdinalIgnoreCase) ||
                            pName.Equals("conhost", StringComparison.OrdinalIgnoreCase) ||
                            pName.Equals("RuntimeBroker", StringComparison.OrdinalIgnoreCase) ||
                            pName.Equals("dllhost", StringComparison.OrdinalIgnoreCase) ||
                            pName.Equals("Bridge", StringComparison.OrdinalIgnoreCase) ||
                            pName.Equals("BridgeHelper", StringComparison.OrdinalIgnoreCase))
                            continue;

                        long wsBytes = 0;
                        try { wsBytes = p.WorkingSet64; } catch { }
                        double memMb = Math.Round((double)wsBytes / (1024.0 * 1024.0), 1);
                        string mainTitle = "";
                        try { mainTitle = (p.MainWindowTitle ?? "").Trim(); } catch { }
                        bool hasWindow = !string.IsNullOrEmpty(mainTitle);

                        if (!hasWindow && memMb < 25.0) continue;

                        bool responding = true;
                        try { responding = p.Responding; } catch { }

                        candidates.Add(new Dictionary<string, object>
                        {
                            { "pid", p.Id },
                            { "name", pName },
                            { "title", hasWindow ? mainTitle : pName },
                            { "hasWindow", hasWindow },
                            { "memoryMb", memMb },
                            { "responding", responding }
                        });
                    }
                    catch { }
                }

                candidates.Sort((a, b) =>
                {
                    bool aw = Convert.ToBoolean(a["hasWindow"]);
                    bool bw = Convert.ToBoolean(b["hasWindow"]);
                    bool ar = Convert.ToBoolean(a["responding"]);
                    bool br = Convert.ToBoolean(b["responding"]);
                    if (ar != br) return ar ? 1 : -1; // Non-responding apps first!
                    if (aw != bw) return aw ? -1 : 1; // Windowed apps next
                    double am = Convert.ToDouble(a["memoryMb"]);
                    double bm = Convert.ToDouble(b["memoryMb"]);
                    return bm.CompareTo(am);
                });

                int limit = Math.Min(30, candidates.Count);
                for (int i = 0; i < limit; i++)
                {
                    result.Add(candidates[i]);
                }
            }
            catch { }
            return result;
        }

        private static object KillProcessCommand(Dictionary<string, object> args)
        {
            int pid = args.ContainsKey("pid") ? Convert.ToInt32(args["pid"]) : 0;
            string procName = args.ContainsKey("name") ? Convert.ToString(args["name"]).Trim() : "";
            string[] protectedProcs = new[] { "csrss", "wininit", "winlogon", "services", "lsass", "smss", "System", "Idle", "explorer", "Bridge", "BridgeHelper" };

            try
            {
                if (pid > 4)
                {
                    Process p = Process.GetProcessById(pid);
                    foreach (var prot in protectedProcs)
                    {
                        if (p.ProcessName.Equals(prot, StringComparison.OrdinalIgnoreCase))
                            throw new Exception("Kritik sistem süreci kapatılamaz: " + p.ProcessName);
                    }
                    p.Kill();
                    return new { ok = true, killedPid = pid, name = p.ProcessName, processes = GetTopProcessesList() };
                }
                else if (!string.IsNullOrEmpty(procName))
                {
                    foreach (var prot in protectedProcs)
                    {
                        if (procName.Equals(prot, StringComparison.OrdinalIgnoreCase))
                            throw new Exception("Kritik sistem süreci kapatılamaz: " + procName);
                    }
                    int count = 0;
                    foreach (var p in Process.GetProcessesByName(procName))
                    {
                        try { p.Kill(); count++; } catch { }
                    }
                    return new { ok = count > 0, killedCount = count, name = procName, processes = GetTopProcessesList() };
                }
            }
            catch (Exception ex)
            {
                return new { ok = false, error = ex.Message, processes = GetTopProcessesList() };
            }
            return new { ok = false, error = "Geçersiz PID veya süreç adı.", processes = GetTopProcessesList() };
        }

        #endregion

        #region Wireless Control (Wi-Fi, Mobile Hotspot & Bluetooth)

        private static string RunHiddenToolCapture(string fileName, string arguments, int timeoutMs = 4500)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = fileName,
                    Arguments = arguments,
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8
                };
                using (Process p = Process.Start(psi))
                {
                    if (p == null) return "";
                    string output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(timeoutMs);
                    return output ?? "";
                }
            }
            catch
            {
                return "";
            }
        }

        private static Dictionary<string, object> QueryWinRtWirelessStateAndAction(string mode, string param1 = "", string param2 = "")
        {
            var fallback = new Dictionary<string, object>();
            try
            {
                string safeMode = (mode ?? "status").Replace("'", "");
                string safeP1 = (param1 ?? "").Replace("'", "");
                string safeP2 = (param2 ?? "").Replace("'", "");

                // Execute a fast hidden PowerShell WinRT script for Radio & Tethering management
                string psScript = @"
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$mode = '" + safeMode + @"'
$p1 = '" + safeP1 + @"'
$p2 = '" + safeP2 + @"'

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
Function Await-WinRt($op, $type) {
    if ($null -eq $op) { return $null }
    $generic = $asTaskGeneric.MakeGenericMethod($type)
    $t = $generic.Invoke($null, @($op))
    $t.Wait(4000) | Out-Null
    return $t.Result
}

$radioType = [Windows.Devices.Radios.Radio,Windows.Devices.Radios,ContentType=WindowsRuntime]
$radioStateType = [Windows.Devices.Radios.RadioState,Windows.Devices.Radios,ContentType=WindowsRuntime]
$radioAccessType = [Windows.Devices.Radios.RadioAccessStatus,Windows.Devices.Radios,ContentType=WindowsRuntime]
$radiosListType = [System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]]
$radios = Await-WinRt ($radioType::GetRadiosAsync()) $radiosListType

$wifiRadio = $null
$btRadio = $null
if ($null -ne $radios) {
    foreach ($r in $radios) {
        if ($r.Kind.ToString() -eq 'WiFi') { $wifiRadio = $r }
        elseif ($r.Kind.ToString() -eq 'Bluetooth') { $btRadio = $r }
    }
}

$netInfoType = [Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]
$tetherMgrType = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager,Windows.Networking.NetworkOperators,ContentType=WindowsRuntime]
$tetherResType = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult,Windows.Networking.NetworkOperators,ContentType=WindowsRuntime]

$profile = $netInfoType::GetInternetConnectionProfile()
if ($null -eq $profile) {
    $allProfiles = $netInfoType::GetConnectionProfiles()
    if ($null -ne $allProfiles -and $allProfiles.Count -gt 0) { $profile = $allProfiles[0] }
}
$tetherMgr = $null
if ($null -ne $profile) {
    try { $tetherMgr = $tetherMgrType::CreateFromConnectionProfile($profile) } catch {}
}

if ($mode -eq 'wifi_toggle' -and $null -ne $wifiRadio) {
    $target = if ($p1 -eq 'true') { $radioStateType::On } else { $radioStateType::Off }
    Await-WinRt ($wifiRadio.SetStateAsync($target)) $radioAccessType | Out-Null
    Start-Sleep -Milliseconds 250
}
elseif ($mode -eq 'bt_toggle' -and $null -ne $btRadio) {
    $target = if ($p1 -eq 'true') { $radioStateType::On } else { $radioStateType::Off }
    Await-WinRt ($btRadio.SetStateAsync($target)) $radioAccessType | Out-Null
    Start-Sleep -Milliseconds 250
}
elseif ($mode -eq 'hotspot_toggle' -and $null -ne $tetherMgr) {
    $wantOn = ($p1 -eq 'true')
    if ($wantOn) {
        Await-WinRt ($tetherMgr.StartTetheringAsync()) $tetherResType | Out-Null
    } else {
        Await-WinRt ($tetherMgr.StopTetheringAsync()) $tetherResType | Out-Null
    }
    for ($w = 0; $w -lt 12; $w++) {
        Start-Sleep -Milliseconds 180
        $stNow = $tetherMgr.TetheringOperationalState.ToString()
        if ($wantOn -and $stNow -eq 'On') { break }
        if ((-not $wantOn) -and $stNow -eq 'Off') { break }
    }
}

$hsSupported = ($null -ne $tetherMgr)
$hsEnabled = $false
$hsSsid = ''
$hsClients = 0
if ($null -ne $tetherMgr) {
    try {
        $stStr = $tetherMgr.TetheringOperationalState.ToString()
        $hsEnabled = ($stStr -eq 'On' -or ($stStr -eq 'InTransition' -and $p1 -ne 'false'))
        $hsClients = [int]$tetherMgr.ClientCount
        $cfg = $tetherMgr.GetCurrentAccessPointConfiguration()
        if ($null -ne $cfg) { $hsSsid = [string]$cfg.Ssid }
    } catch {}
}

$out = @{
    wifiRadioSupported = ($null -ne $wifiRadio)
    wifiRadioOn = if ($null -ne $wifiRadio) { $wifiRadio.State.ToString() -eq 'On' } else { $false }
    btSupported = ($null -ne $btRadio)
    btOn = if ($null -ne $btRadio) { $btRadio.State.ToString() -eq 'On' } else { $false }
    btDevices = @()
    hotspotSupported = $hsSupported
    hotspotEnabled = $hsEnabled
    hotspotSsid = $hsSsid
    hotspotClients = $hsClients
}
ConvertTo-Json $out -Compress
";
                string encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(psScript));
                string rawJson = RunHiddenToolCapture(
                    "powershell.exe",
                    "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand " + encoded,
                    7000
                ).Trim();

                if (!string.IsNullOrEmpty(rawJson))
                {
                    int braceStart = rawJson.IndexOf('{');
                    int braceEnd = rawJson.LastIndexOf('}');
                    if (braceStart >= 0 && braceEnd > braceStart)
                    {
                        string cleanJson = rawJson.Substring(braceStart, braceEnd - braceStart + 1);
                        var parsed = serializer.Deserialize<Dictionary<string, object>>(cleanJson);
                        if (parsed != null) return parsed;
                    }
                }
            }
            catch { }
            return fallback;
        }

        private static Dictionary<string, object> ParseNetshWifiInterfaces()
        {
            bool hasAdapter = false;
            bool connected = false;
            bool radioOn = true;
            string ssid = "";
            int signal = 0;
            string radioType = "";

            string output = RunHiddenToolCapture("netsh.exe", "wlan show interfaces", 2500);
            if (!string.IsNullOrWhiteSpace(output))
            {
                string[] lines = output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                foreach (var rawLine in lines)
                {
                    int colon = rawLine.IndexOf(':');
                    if (colon <= 0 || colon >= rawLine.Length - 1) continue;
                    string key = rawLine.Substring(0, colon).Trim().ToLowerInvariant();
                    string val = rawLine.Substring(colon + 1).Trim();

                    if (key == "name" || key == "ad" || key == "isim")
                    {
                        hasAdapter = true;
                    }
                    else if (key == "state" || key == "durum")
                    {
                        hasAdapter = true;
                        if (val.IndexOf("connected", StringComparison.OrdinalIgnoreCase) >= 0 &&
                            val.IndexOf("disconnected", StringComparison.OrdinalIgnoreCase) < 0)
                        {
                            connected = true;
                        }
                        else if (val.IndexOf("bağlı", StringComparison.OrdinalIgnoreCase) >= 0 &&
                                 val.IndexOf("kesildi", StringComparison.OrdinalIgnoreCase) < 0 &&
                                 val.IndexOf("değil", StringComparison.OrdinalIgnoreCase) < 0)
                        {
                            connected = true;
                        }
                    }
                    else if (key == "ssid")
                    {
                        ssid = val;
                    }
                    else if (key == "signal" || key == "sinyal")
                    {
                        string numStr = val.Replace("%", "").Trim();
                        int sigVal;
                        if (int.TryParse(numStr, out sigVal)) signal = sigVal;
                    }
                    else if (key == "radio type" || key == "radyo türü")
                    {
                        radioType = val;
                    }
                    else if (key.Contains("software") || key.Contains("yazılım") || key.Contains("hardware") || key.Contains("donanım"))
                    {
                        if (val.IndexOf("off", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            val.IndexOf("kapalı", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            radioOn = false;
                        }
                    }
                }
            }

            return new Dictionary<string, object>
            {
                { "supported", hasAdapter },
                { "enabled", hasAdapter && radioOn },
                { "connected", connected },
                { "ssid", connected ? ssid : "" },
                { "signal", connected ? signal : 0 },
                { "radioType", radioType }
            };
        }

        private static List<Dictionary<string, object>> ScanWifiNetworksList(string currentConnectedSsid)
        {
            var list = new List<Dictionary<string, object>>();
            var savedProfiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            string profOut = RunHiddenToolCapture("netsh.exe", "wlan show profiles", 2500);
            if (!string.IsNullOrEmpty(profOut))
            {
                foreach (var line in profOut.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    int colon = line.IndexOf(':');
                    if (colon > 0 && colon < line.Length - 1)
                    {
                        string pName = line.Substring(colon + 1).Trim();
                        if (!string.IsNullOrEmpty(pName)) savedProfiles.Add(pName);
                    }
                }
            }

            string netOut = RunHiddenToolCapture("netsh.exe", "wlan show networks mode=bssid", 3500);
            if (!string.IsNullOrEmpty(netOut))
            {
                string currentSsid = null;
                string currentAuth = "WPA2";
                int bestSignal = 0;
                var bySsid = new Dictionary<string, Dictionary<string, object>>(StringComparer.OrdinalIgnoreCase);

                foreach (var rawLine in netOut.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    string line = rawLine.Trim();
                    int colon = line.IndexOf(':');
                    if (colon <= 0) continue;
                    string key = line.Substring(0, colon).Trim();
                    string val = colon < line.Length - 1 ? line.Substring(colon + 1).Trim() : "";

                    if (key.StartsWith("SSID ", StringComparison.OrdinalIgnoreCase))
                    {
                        currentSsid = val;
                        bestSignal = 0;
                        if (!string.IsNullOrEmpty(currentSsid) && !bySsid.ContainsKey(currentSsid))
                        {
                            bool isConn = !string.IsNullOrEmpty(currentConnectedSsid) && string.Equals(currentSsid, currentConnectedSsid, StringComparison.OrdinalIgnoreCase);
                            bySsid[currentSsid] = new Dictionary<string, object>
                            {
                                { "ssid", currentSsid },
                                { "security", "WPA2" },
                                { "signal", 0 },
                                { "isSaved", savedProfiles.Contains(currentSsid) },
                                { "isConnected", isConn },
                                { "connected", isConn }
                            };
                        }
                    }
                    else if (!string.IsNullOrEmpty(currentSsid) && bySsid.ContainsKey(currentSsid))
                    {
                        string kLow = key.ToLowerInvariant();
                        if (kLow.Contains("authentication") || kLow.Contains("kimlik"))
                        {
                            currentAuth = val;
                            bySsid[currentSsid]["security"] = currentAuth;
                        }
                        else if (kLow.Contains("signal") || kLow.Contains("sinyal"))
                        {
                            int sig;
                            if (int.TryParse(val.Replace("%", "").Trim(), out sig))
                            {
                                if (sig > bestSignal) bestSignal = sig;
                                int prevSig = Convert.ToInt32(bySsid[currentSsid]["signal"]);
                                if (sig > prevSig) bySsid[currentSsid]["signal"] = sig;
                            }
                        }
                    }
                }

                foreach (var kv in bySsid)
                {
                    list.Add(kv.Value);
                }

                list.Sort((a, b) =>
                {
                    bool ac = Convert.ToBoolean(a["isConnected"]);
                    bool bc = Convert.ToBoolean(b["isConnected"]);
                    if (ac != bc) return ac ? -1 : 1;
                    bool asv = Convert.ToBoolean(a["isSaved"]);
                    bool bsv = Convert.ToBoolean(b["isSaved"]);
                    if (asv != bsv) return asv ? -1 : 1;
                    int asig = Convert.ToInt32(a["signal"]);
                    int bsig = Convert.ToInt32(b["signal"]);
                    return bsig.CompareTo(asig);
                });
            }

            return list;
        }

        private static bool ConnectToWifiNetwork(string ssid, string password)
        {
            if (string.IsNullOrWhiteSpace(ssid)) return false;
            try
            {
                if (!string.IsNullOrEmpty(password))
                {
                    string safeSsidXml = System.Security.SecurityElement.Escape(ssid);
                    string safePassXml = System.Security.SecurityElement.Escape(password);
                    string hexSsid = BitConverter.ToString(Encoding.UTF8.GetBytes(ssid)).Replace("-", "");

                    string profileXml = "<?xml version=\"1.0\"?>\r\n" +
                        "<WLANProfile xmlns=\"http://www.microsoft.com/networking/WLAN/profile/v1\">\r\n" +
                        "  <name>" + safeSsidXml + "</name>\r\n" +
                        "  <SSIDConfig>\r\n" +
                        "    <SSID>\r\n" +
                        "      <hex>" + hexSsid + "</hex>\r\n" +
                        "      <name>" + safeSsidXml + "</name>\r\n" +
                        "    </SSID>\r\n" +
                        "  </SSIDConfig>\r\n" +
                        "  <connectionType>ESS</connectionType>\r\n" +
                        "  <connectionMode>auto</connectionMode>\r\n" +
                        "  <MSM>\r\n" +
                        "    <security>\r\n" +
                        "      <authEncryption>\r\n" +
                        "        <authentication>WPA2PSK</authentication>\r\n" +
                        "        <encryption>AES</encryption>\r\n" +
                        "        <useOneX>false</useOneX>\r\n" +
                        "      </authEncryption>\r\n" +
                        "      <sharedKey>\r\n" +
                        "        <keyType>passPhrase</keyType>\r\n" +
                        "        <protected>false</protected>\r\n" +
                        "        <keyMaterial>" + safePassXml + "</keyMaterial>\r\n" +
                        "      </sharedKey>\r\n" +
                        "    </security>\r\n" +
                        "  </MSM>\r\n" +
                        "</WLANProfile>";

                    string tmpXml = Path.Combine(Path.GetTempPath(), "bridge_wlan_" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".xml");
                    try
                    {
                        File.WriteAllText(tmpXml, profileXml, Encoding.UTF8);
                        RunHiddenToolCapture("netsh.exe", "wlan add profile filename=\"" + tmpXml + "\" user=all", 3000);
                    }
                    finally
                    {
                        try { if (File.Exists(tmpXml)) File.Delete(tmpXml); } catch { }
                    }
                }

                string cleanSsid = ssid.Replace("\"", "");
                RunHiddenToolCapture("netsh.exe", "wlan connect name=\"" + cleanSsid + "\" ssid=\"" + cleanSsid + "\"", 3500);
                Thread.Sleep(900);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static object HandleWirelessControl(Dictionary<string, object> args)
        {
            string action = args.ContainsKey("action") ? Convert.ToString(args["action"]) : "status";
            string winRtMode = "status";
            string p1 = "";
            string p2 = "";

            if (action == "wifi_toggle")
            {
                bool en = !args.ContainsKey("enabled") || Convert.ToBoolean(args["enabled"]);
                winRtMode = "wifi_toggle";
                p1 = en ? "true" : "false";
            }
            else if (action == "bt_toggle")
            {
                bool en = !args.ContainsKey("enabled") || Convert.ToBoolean(args["enabled"]);
                winRtMode = "bt_toggle";
                p1 = en ? "true" : "false";
            }
            else if (action == "hotspot_toggle")
            {
                bool en = !args.ContainsKey("enabled") || Convert.ToBoolean(args["enabled"]);
                winRtMode = "hotspot_toggle";
                p1 = en ? "true" : "false";
            }
            else if (action == "wifi_connect")
            {
                string ssid = args.ContainsKey("ssid") ? Convert.ToString(args["ssid"]).Trim() : "";
                string pass = args.ContainsKey("password") ? Convert.ToString(args["password"]) : "";
                ConnectToWifiNetwork(ssid, pass);
            }
            else if (action == "wifi_disconnect")
            {
                RunHiddenToolCapture("netsh.exe", "wlan disconnect", 2500);
                Thread.Sleep(400);
            }

            var winRt = QueryWinRtWirelessStateAndAction(winRtMode, p1, p2);
            var wifiInfo = ParseNetshWifiInterfaces();

            if (winRt.ContainsKey("wifiRadioSupported") && Convert.ToBoolean(winRt["wifiRadioSupported"]))
            {
                wifiInfo["supported"] = true;
                wifiInfo["enabled"] = Convert.ToBoolean(winRt["wifiRadioOn"]);
            }

            string currentSsid = wifiInfo.ContainsKey("ssid") ? Convert.ToString(wifiInfo["ssid"]) : "";
            object networks = null;
            if (action == "wifi_scan")
            {
                networks = ScanWifiNetworksList(currentSsid);
            }

            bool hsEnabledVal = winRt.ContainsKey("hotspotEnabled") && Convert.ToBoolean(winRt["hotspotEnabled"]);
            if (!hsEnabledVal && action != "hotspot_toggle")
            {
                try
                {
                    foreach (var ni in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces())
                    {
                        if (ni.OperationalStatus == System.Net.NetworkInformation.OperationalStatus.Up &&
                            ni.Description != null &&
                            ni.Description.IndexOf("Wi-Fi Direct Virtual Adapter", StringComparison.OrdinalIgnoreCase) >= 0)
                        {
                            hsEnabledVal = true;
                            break;
                        }
                    }
                }
                catch { }
            }

            var hotspotInfo = new Dictionary<string, object>
            {
                { "supported", winRt.ContainsKey("hotspotSupported") ? Convert.ToBoolean(winRt["hotspotSupported"]) : true },
                { "enabled", hsEnabledVal },
                { "ssid", winRt.ContainsKey("hotspotSsid") && !string.IsNullOrEmpty(Convert.ToString(winRt["hotspotSsid"])) ? Convert.ToString(winRt["hotspotSsid"]) : Environment.MachineName },
                { "clients", winRt.ContainsKey("hotspotClients") ? Convert.ToInt32(winRt["hotspotClients"]) : 0 }
            };

            var btInfo = new Dictionary<string, object>
            {
                { "supported", winRt.ContainsKey("btSupported") && Convert.ToBoolean(winRt["btSupported"]) },
                { "enabled", winRt.ContainsKey("btOn") && Convert.ToBoolean(winRt["btOn"]) },
                { "devices", winRt.ContainsKey("btDevices") ? winRt["btDevices"] : new string[0] }
            };

            return new
            {
                ok = true,
                action = action,
                wifi = wifiInfo,
                hotspot = hotspotInfo,
                bluetooth = btInfo,
                networks = networks
            };
        }

        #endregion
    }
}
