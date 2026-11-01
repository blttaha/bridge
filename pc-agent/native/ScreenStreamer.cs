using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

namespace TahaBLT
{
    // Remote Desktop streaming engine (protocol v2).
    //
    // Modelled after Chrome Remote Desktop's host pipeline:
    //  * change-driven capture (DXGI Desktop Duplication, GDI fallback) instead of blind polling
    //  * only dirty 64x64 tiles are re-encoded and sent (merged into rectangles)
    //  * cursor is NOT baked into the image; shape + position are sent separately and drawn on the client
    //  * "top-off": while the screen is moving, tiles may be sent scaled down / at lower quality; as soon as
    //    the screen becomes idle those tiles are re-sent at native resolution with 4:4:4 chroma, so a still
    //    desktop is always pixel-sharp (fixes blurry / blocky text in fullscreen)
    //  * flow control is ack based and lives in server.js (one request -> one frame)
    //
    // Request (24 bytes, little endian):
    //   u32 magic 'TBR3' | i32 monitorIndex | u16 maxCanvasWidth | u16 motionScale (permille)
    //   u8 motionQuality | u8 refineQuality | u8 mode (0 delta, 1 refine, 2 key) | u8 flags (1: 4:4:4, 2: video ok, 4: AV1 ok)
    //   u16 waitMs | u16 videoBitrate (x100 kbps) | u16 videoMaxWidth | u16 fps
    //
    // Response frame (forwarded verbatim to the phone):
    //   u32 magic 'TBF2' | u32 frameId | u16 flags | u16 rectCount | u16 canvasW | u16 canvasH | u16 srcW | u16 srcH
    //   u16 cursorX (0..65535) | u16 cursorY | u16 workMs | u16 inputSeq (last pointer input applied, see SendInputCommand)
    //   [cursor shape: u16 hotX | u16 hotY | u16 w | u16 h | u32 pngLen | png]   (flag 0x08)
    //   [video: u16 videoW | u16 videoH | u32 len | access unit]   (flag 0x80, key: 0x100, AV1: 0x200)
    //   H.264 access units are Annex B; AV1 ones are temporal units in the low-overhead OBU format
    //   rectCount x [u16 x | u16 y | u16 w | u16 h | u32 jpegLen | jpeg]          (canvas space)
    //   For video frames the rects carry no JPEG (len 0): they are the regions of the decoded picture
    //   that changed and must be painted, so sharp top-off tiles elsewhere are preserved.
    public partial class Program
    {
        private const uint STREAM_REQ_MAGIC = 0x33524254;   // "TBR3"
        private const uint STREAM_FRAME_MAGIC = 0x32464254; // "TBF2"

        private const int FRAME_FLAG_KEY = 0x01;
        private const int FRAME_FLAG_REFINE = 0x02;
        private const int FRAME_FLAG_CURSOR_VISIBLE = 0x04;
        private const int FRAME_FLAG_CURSOR_SHAPE = 0x08;
        private const int FRAME_FLAG_IDLE = 0x10;
        private const int FRAME_FLAG_PENDING_REFINE = 0x20;
        private const int FRAME_FLAG_DXGI = 0x40;
        private const int FRAME_FLAG_VIDEO = 0x80;
        private const int FRAME_FLAG_VIDEO_KEY = 0x100;
        private const int FRAME_FLAG_VIDEO_AV1 = 0x200;

        // Loopback ports are reachable by every local process and by web pages (fetch to 127.0.0.1), so each
        // connection must start with the per-run secret that server.js passes in TAHABLT_IPC_KEY.
        private static readonly string ipcKey = Environment.GetEnvironmentVariable("TAHABLT_IPC_KEY") ?? "";

        private static bool CheckIpcKey(Stream stream)
        {
            if (ipcKey.Length < 32) return false;
            var sb = new System.Text.StringBuilder();
            while (sb.Length <= 128)
            {
                int b = stream.ReadByte();
                if (b < 0) return false;
                if (b == 10) break;
                sb.Append((char)b);
            }
            string got = sb.ToString().Trim();
            if (got.Length != ipcKey.Length) return false;
            int diff = 0;
            for (int i = 0; i < got.Length; i++) diff |= got[i] ^ ipcKey[i];
            return diff == 0;
        }

        private static void StartBinaryStreamServer()
        {
            Thread serverThread = new Thread(() =>
            {
                try
                {
                    int port = 4852;
                    int envPort;
                    if (int.TryParse(Environment.GetEnvironmentVariable("TAHABLT_STREAM_PORT") ?? "", out envPort) && envPort > 0) port = envPort;
                    TcpListener listener = new TcpListener(IPAddress.Loopback, port);
                    listener.Start();
                    while (true)
                    {
                        TcpClient client = listener.AcceptTcpClient();
                        Thread t = new Thread(() =>
                        {
                            using (var session = new ScreenStreamSession(client))
                            {
                                session.Run();
                            }
                        });
                        t.IsBackground = true;
                        t.Priority = ThreadPriority.AboveNormal;
                        t.Start();
                    }
                }
                catch { }
            });
            serverThread.IsBackground = true;
            serverThread.Start();
        }

        #region Streaming P/Invoke

        private static class SN
        {
            [DllImport("user32.dll")]
            public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

            [DllImport("user32.dll")]
            public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumDelegate lpfnEnum, IntPtr dwData);

            public delegate bool MonitorEnumDelegate(IntPtr hMonitor, IntPtr hdcMonitor, ref RECT lprcMonitor, IntPtr dwData);

            [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
            public struct MONITORINFOEX
            {
                public int cbSize;
                public RECT rcMonitor;
                public RECT rcWork;
                public uint dwFlags;
                [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
                public string szDevice;
            }

            [DllImport("user32.dll", CharSet = CharSet.Unicode)]
            public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX lpmi);

            [DllImport("user32.dll")]
            public static extern int GetSystemMetrics(int nIndex);

            [StructLayout(LayoutKind.Sequential)]
            public struct CURSORINFO_S
            {
                public int cbSize;
                public int flags;
                public IntPtr hCursor;
                public int x;
                public int y;
            }

            [DllImport("user32.dll")]
            public static extern bool GetCursorInfo(ref CURSORINFO_S pci);

            [StructLayout(LayoutKind.Sequential)]
            public struct ICONINFO_S
            {
                public bool fIcon;
                public int xHotspot;
                public int yHotspot;
                public IntPtr hbmMask;
                public IntPtr hbmColor;
            }

            [DllImport("user32.dll")]
            public static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO_S piconinfo);

            [StructLayout(LayoutKind.Sequential)]
            public struct BITMAP_S
            {
                public int bmType;
                public int bmWidth;
                public int bmHeight;
                public int bmWidthBytes;
                public ushort bmPlanes;
                public ushort bmBitsPixel;
                public IntPtr bmBits;
            }

            [DllImport("gdi32.dll")]
            public static extern int GetObject(IntPtr h, int c, out BITMAP_S pv);

            [StructLayout(LayoutKind.Sequential)]
            public struct BITMAPINFOHEADER
            {
                public int biSize;
                public int biWidth;
                public int biHeight;
                public ushort biPlanes;
                public ushort biBitCount;
                public uint biCompression;
                public uint biSizeImage;
                public int biXPelsPerMeter;
                public int biYPelsPerMeter;
                public uint biClrUsed;
                public uint biClrImportant;
            }

            [DllImport("gdi32.dll")]
            public static extern int GetDIBits(IntPtr hdc, IntPtr hbm, uint start, uint cLines, IntPtr lpvBits, IntPtr lpbmi, uint usage);

            [DllImport("gdi32.dll")]
            public static extern IntPtr CreateDIBSection(IntPtr hdc, IntPtr pbmi, uint usage, out IntPtr ppvBits, IntPtr hSection, uint offset);

            [DllImport("gdi32.dll")]
            public static extern IntPtr CreateCompatibleDC(IntPtr hdc);

            [DllImport("gdi32.dll")]
            public static extern IntPtr SelectObject(IntPtr hdc, IntPtr h);

            [DllImport("gdi32.dll")]
            public static extern bool DeleteDC(IntPtr hdc);

            [DllImport("gdi32.dll")]
            public static extern bool DeleteObject(IntPtr h);

            [DllImport("gdi32.dll")]
            public static extern bool BitBlt(IntPtr hdc, int x, int y, int cx, int cy, IntPtr hdcSrc, int x1, int y1, uint rop);

            [DllImport("user32.dll")]
            public static extern IntPtr GetDC(IntPtr hWnd);

            [DllImport("user32.dll")]
            public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

            [DllImport("winmm.dll")]
            public static extern uint timeBeginPeriod(uint uMilliseconds);

            [DllImport("winmm.dll")]
            public static extern uint timeEndPeriod(uint uMilliseconds);

            [DllImport("ole32.dll")]
            public static extern int CoInitializeEx(IntPtr pvReserved, uint dwCoInit);

            [DllImport("ole32.dll")]
            public static extern int CoCreateInstance(ref Guid rclsid, IntPtr pUnkOuter, uint dwClsContext, ref Guid riid, out IntPtr ppv);

            [DllImport("dxgi.dll")]
            public static extern int CreateDXGIFactory1(ref Guid riid, out IntPtr ppFactory);

            [DllImport("d3d11.dll")]
            public static extern int D3D11CreateDevice(
                IntPtr pAdapter, int DriverType, IntPtr Software, uint Flags,
                IntPtr pFeatureLevels, uint FeatureLevels, uint SDKVersion,
                out IntPtr ppDevice, out int pFeatureLevel, out IntPtr ppImmediateContext);
        }

        private static unsafe T ComFn<T>(IntPtr comObj, int slot) where T : class
        {
            IntPtr vtbl = *(IntPtr*)comObj;
            IntPtr fn = *((IntPtr*)vtbl + slot);
            return Marshal.GetDelegateForFunctionPointer(fn, typeof(T)) as T;
        }

        private static void ComRelease(ref IntPtr p)
        {
            if (p != IntPtr.Zero)
            {
                try { Marshal.Release(p); } catch { }
                p = IntPtr.Zero;
            }
        }

        #endregion

        #region Pixel helpers

        // Area-averaging (box) resampler for 32bpp BGRX buffers. Used for canvas downscaling (e.g. 4K -> 2560)
        // and for motion-quality scaled tiles. Nearest/2x2 sampling caused the "pixel pixel" look before.
        private static unsafe void BoxResample(IntPtr src, int sPitch, int sw, int sh, IntPtr dst, int dPitch, int dw, int dh)
        {
            if (sw == dw && sh == dh)
            {
                for (int y = 0; y < sh; y++)
                {
                    Buffer.MemoryCopy((byte*)src + (long)y * sPitch, (byte*)dst + (long)y * dPitch, dPitch, (long)sw * 4);
                }
                return;
            }

            int[] xs0 = new int[dw];
            int[] xs1 = new int[dw];
            for (int x = 0; x < dw; x++)
            {
                int a = (int)((long)x * sw / dw);
                int b = (int)((long)(x + 1) * sw / dw);
                if (b <= a) b = a + 1;
                if (b > sw) b = sw;
                xs0[x] = a;
                xs1[x] = b;
            }

            Parallel.For(0, dh, y =>
            {
                int sy0 = (int)((long)y * sh / dh);
                int sy1 = (int)((long)(y + 1) * sh / dh);
                if (sy1 <= sy0) sy1 = sy0 + 1;
                if (sy1 > sh) sy1 = sh;
                uint* dRow = (uint*)((byte*)dst + (long)y * dPitch);
                for (int x = 0; x < dw; x++)
                {
                    int sx0 = xs0[x];
                    int sx1 = xs1[x];
                    uint r = 0, g = 0, b = 0, n = 0;
                    for (int sy = sy0; sy < sy1; sy++)
                    {
                        uint* sRow = (uint*)((byte*)src + (long)sy * sPitch);
                        for (int sx = sx0; sx < sx1; sx++)
                        {
                            uint c = sRow[sx];
                            b += c & 0xFF;
                            g += (c >> 8) & 0xFF;
                            r += (c >> 16) & 0xFF;
                            n++;
                        }
                    }
                    uint h = n >> 1;
                    dRow[x] = 0xFF000000u | (((r + h) / n) << 16) | (((g + h) / n) << 8) | ((b + h) / n);
                }
            });
        }

        #endregion

        #region JPEG encoding (WIC with 4:4:4 support, GDI+ fallback)

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int WicCreateEncoderDel(IntPtr self, ref Guid container, IntPtr vendor, out IntPtr encoder);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int WicCreateStreamDel(IntPtr self, out IntPtr stream);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int WicStreamInitMemDel(IntPtr self, IntPtr buffer, uint size);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int IStreamSeekDel(IntPtr self, long move, uint origin, out ulong newPos);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int WicEncInitDel(IntPtr self, IntPtr stream, int cacheOption);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int WicEncNewFrameDel(IntPtr self, out IntPtr frame, out IntPtr propBag);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int WicCommitDel(IntPtr self);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int WicFrameInitDel(IntPtr self, IntPtr propBag);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int WicFrameSetSizeDel(IntPtr self, uint w, uint h);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int WicFrameSetPixFmtDel(IntPtr self, ref Guid fmt);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int WicFrameWritePixelsDel(IntPtr self, uint lines, uint stride, uint size, IntPtr pixels);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int PropBagWriteDel(IntPtr self, uint count, IntPtr propBag2Array, IntPtr variantArray);

        private static IntPtr wicFactory = IntPtr.Zero;
        private static bool wicFactoryTried = false;
        private static bool wicBroken = false;
        private static readonly object wicInitLock = new object();

        private static IntPtr GetWicFactory()
        {
            lock (wicInitLock)
            {
                if (wicFactoryTried) return wicFactory;
                wicFactoryTried = true;
                try
                {
                    Guid clsid = new Guid("cacaf262-9370-4615-a13b-9f5539da4c0a");
                    Guid iid = new Guid("ec5ec8a9-c395-4314-9c77-54d7a935ff70");
                    IntPtr f;
                    if (SN.CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iid, out f) == 0) wicFactory = f;
                }
                catch { wicFactory = IntPtr.Zero; }
                return wicFactory;
            }
        }

        private sealed class JpegEncoder : IDisposable
        {
            private IntPtr outBuf = IntPtr.Zero;
            private int outBufSize = 0;
            private IntPtr rgbBuf = IntPtr.Zero;
            private int rgbBufSize = 0;
            private IntPtr propNames = IntPtr.Zero;
            private IntPtr propArr = IntPtr.Zero;
            private IntPtr varArr = IntPtr.Zero;
            private readonly Dictionary<long, EncoderParameters> gdiParams = new Dictionary<long, EncoderParameters>();
            private ImageCodecInfo gdiCodec;
            private readonly MemoryStream gdiStream = new MemoryStream(1 << 18);

            public JpegEncoder()
            {
                foreach (var codec in ImageCodecInfo.GetImageEncoders())
                {
                    if (codec.FormatID == ImageFormat.Jpeg.Guid) { gdiCodec = codec; break; }
                }
                propNames = Marshal.StringToHGlobalUni("ImageQuality\0JpegYCrCbSubsampling\0");
                propArr = Marshal.AllocHGlobal(40 * 2);
                varArr = Marshal.AllocHGlobal(24 * 2);
            }

            private static void EnsureBuf(ref IntPtr p, ref int size, int need)
            {
                if (size >= need) return;
                if (p != IntPtr.Zero) Marshal.FreeHGlobal(p);
                size = need + (need >> 2);
                p = Marshal.AllocHGlobal(size);
            }

            public byte[] Encode(IntPtr pixels, int stride, int w, int h, int quality, bool chroma444)
            {
                if (!wicBroken && GetWicFactory() != IntPtr.Zero)
                {
                    try
                    {
                        byte[] r = EncodeWic(pixels, stride, w, h, quality, chroma444);
                        if (r != null) return r;
                    }
                    catch { }
                }
                return EncodeGdi(pixels, stride, w, h, quality);
            }

            private unsafe byte[] EncodeWic(IntPtr pixels, int stride, int w, int h, int quality, bool chroma444)
            {
                IntPtr factory = GetWicFactory();
                IntPtr stream = IntPtr.Zero, encoder = IntPtr.Zero, frame = IntPtr.Zero, bag = IntPtr.Zero;
                try
                {
                    EnsureBuf(ref outBuf, ref outBufSize, w * h * 3 + 65536);
                    if (ComFn<WicCreateStreamDel>(factory, 14)(factory, out stream) != 0) return null;
                    if (ComFn<WicStreamInitMemDel>(stream, 16)(stream, outBuf, (uint)outBufSize) != 0) return null;

                    Guid jpegContainer = new Guid("19e4a5aa-5662-4fc5-a0c0-1758028e1057");
                    if (ComFn<WicCreateEncoderDel>(factory, 8)(factory, ref jpegContainer, IntPtr.Zero, out encoder) != 0) return null;
                    if (ComFn<WicEncInitDel>(encoder, 3)(encoder, stream, 2) != 0) return null;
                    if (ComFn<WicEncNewFrameDel>(encoder, 10)(encoder, out frame, out bag) != 0) return null;

                    if (bag != IntPtr.Zero)
                    {
                        // PROPBAG2 x2 (40 bytes each on x64): dwType, vt, cfType, dwHint, pstrName, clsid
                        byte* pb = (byte*)propArr;
                        for (int i = 0; i < 80; i++) pb[i] = 0;
                        *(ushort*)(pb + 4) = 4;  // VT_R4
                        *(IntPtr*)(pb + 16) = propNames;
                        *(ushort*)(pb + 40 + 4) = 17; // VT_UI1
                        *(IntPtr*)(pb + 40 + 16) = propNames + 13 * 2;

                        byte* pv = (byte*)varArr;
                        for (int i = 0; i < 48; i++) pv[i] = 0;
                        *(ushort*)pv = 4;
                        *(float*)(pv + 8) = Math.Max(0.05f, Math.Min(1.0f, quality / 100f));
                        *(ushort*)(pv + 24) = 17;
                        *(pv + 24 + 8) = (byte)(chroma444 ? 3 : 1); // WICJpegYCrCbSubsampling444 / 420
                        ComFn<PropBagWriteDel>(bag, 4)(bag, 2, propArr, varArr);
                    }

                    if (ComFn<WicFrameInitDel>(frame, 3)(frame, bag) != 0) return null;
                    if (ComFn<WicFrameSetSizeDel>(frame, 4)(frame, (uint)w, (uint)h) != 0) return null;

                    Guid fmt = new Guid("6fddc324-4e03-4bfe-b185-3d77768dc90e"); // 32bppBGR
                    Guid requested = fmt;
                    if (ComFn<WicFrameSetPixFmtDel>(frame, 6)(frame, ref fmt) != 0) return null;

                    int hr;
                    if (fmt == requested)
                    {
                        hr = ComFn<WicFrameWritePixelsDel>(frame, 10)(frame, (uint)h, (uint)stride, (uint)(stride * h), pixels);
                    }
                    else if (fmt == new Guid("6fddc324-4e03-4bfe-b185-3d77768dc90c")) // 24bppBGR
                    {
                        int rgbStride = (w * 3 + 3) & ~3;
                        EnsureBuf(ref rgbBuf, ref rgbBufSize, rgbStride * h);
                        IntPtr dstBase = rgbBuf;
                        Parallel.For(0, h, y =>
                        {
                            byte* s = (byte*)pixels + (long)y * stride;
                            byte* d = (byte*)dstBase + (long)y * rgbStride;
                            for (int x = 0; x < w; x++)
                            {
                                d[0] = s[0]; d[1] = s[1]; d[2] = s[2];
                                d += 3; s += 4;
                            }
                        });
                        hr = ComFn<WicFrameWritePixelsDel>(frame, 10)(frame, (uint)h, (uint)rgbStride, (uint)(rgbStride * h), rgbBuf);
                    }
                    else
                    {
                        wicBroken = true;
                        return null;
                    }
                    if (hr != 0) return null;
                    if (ComFn<WicCommitDel>(frame, 12)(frame) != 0) return null;
                    if (ComFn<WicCommitDel>(encoder, 11)(encoder) != 0) return null;

                    ulong len;
                    if (ComFn<IStreamSeekDel>(stream, 5)(stream, 0, 1, out len) != 0 || len == 0 || len > (ulong)outBufSize) return null;
                    byte[] result = new byte[(int)len];
                    Marshal.Copy(outBuf, result, 0, (int)len);
                    return result;
                }
                finally
                {
                    ComRelease(ref bag);
                    ComRelease(ref frame);
                    ComRelease(ref encoder);
                    ComRelease(ref stream);
                }
            }

            private byte[] EncodeGdi(IntPtr pixels, int stride, int w, int h, int quality)
            {
                using (var bmp = new Bitmap(w, h, stride, PixelFormat.Format32bppRgb, pixels))
                {
                    gdiStream.SetLength(0);
                    if (gdiCodec != null)
                    {
                        EncoderParameters ep;
                        if (!gdiParams.TryGetValue(quality, out ep))
                        {
                            ep = new EncoderParameters(1);
                            ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                            gdiParams[quality] = ep;
                        }
                        bmp.Save(gdiStream, gdiCodec, ep);
                    }
                    else
                    {
                        bmp.Save(gdiStream, ImageFormat.Jpeg);
                    }
                    return gdiStream.ToArray();
                }
            }

            public void Dispose()
            {
                if (outBuf != IntPtr.Zero) { Marshal.FreeHGlobal(outBuf); outBuf = IntPtr.Zero; }
                if (rgbBuf != IntPtr.Zero) { Marshal.FreeHGlobal(rgbBuf); rgbBuf = IntPtr.Zero; }
                if (propNames != IntPtr.Zero) { Marshal.FreeHGlobal(propNames); propNames = IntPtr.Zero; }
                if (propArr != IntPtr.Zero) { Marshal.FreeHGlobal(propArr); propArr = IntPtr.Zero; }
                if (varArr != IntPtr.Zero) { Marshal.FreeHGlobal(varArr); varArr = IntPtr.Zero; }
                foreach (var ep in gdiParams.Values) { try { ep.Dispose(); } catch { } }
                gdiParams.Clear();
            }
        }

        #endregion

        #region DXGI Desktop Duplication capturer

        [StructLayout(LayoutKind.Sequential)]
        private struct DxgiFrameInfo
        {
            public long LastPresentTime;
            public long LastMouseUpdateTime;
            public uint AccumulatedFrames;
            public int RectsCoalesced;
            public int ProtectedContentMaskedOut;
            public int PointerX;
            public int PointerY;
            public int PointerVisible;
            public uint TotalMetadataBufferSize;
            public uint PointerShapeBufferSize;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct DxgiOutputDesc
        {
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
            public string DeviceName;
            public RECT DesktopCoordinates;
            public int AttachedToDesktop;
            public int Rotation;
            public IntPtr Monitor;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct D3DTexDesc
        {
            public uint Width, Height, MipLevels, ArraySize;
            public uint Format, SampleCount, SampleQuality, Usage, BindFlags, CPUAccessFlags, MiscFlags;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct D3DMapped
        {
            public IntPtr pData;
            public uint RowPitch;
            public uint DepthPitch;
        }

        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int DxEnumAdapters1Del(IntPtr self, uint idx, out IntPtr adapter);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int DxEnumOutputsDel(IntPtr self, uint idx, out IntPtr output);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int DxGetOutputDescDel(IntPtr self, out DxgiOutputDesc desc);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int DxDuplicateOutputDel(IntPtr self, IntPtr device, out IntPtr dupl);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int DxAcquireDel(IntPtr self, uint timeoutMs, out DxgiFrameInfo fi, out IntPtr resource);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int DxReleaseFrameDel(IntPtr self);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int DxCreateTex2DDel(IntPtr self, ref D3DTexDesc desc, IntPtr init, out IntPtr tex);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate void DxCopyResourceDel(IntPtr self, IntPtr dst, IntPtr src);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate int DxMapDel(IntPtr self, IntPtr res, uint sub, uint mapType, uint flags, out D3DMapped mapped);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)]
        private delegate void DxUnmapDel(IntPtr self, IntPtr res, uint sub);

        private enum CaptureResult { NewFrame, NoChange, Failed }

        private sealed class DxgiCapturer : IDisposable
        {
            private IntPtr device, context, dupl, staging;
            private int width, height;
            private DxAcquireDel acquire;
            private DxReleaseFrameDel release;
            private DxCopyResourceDel copy;
            private DxMapDel map;
            private DxUnmapDel unmap;

            public bool IsReady { get { return dupl != IntPtr.Zero; } }

            public bool Initialize(int monX, int monY, int monW, int monH)
            {
                Dispose();
                IntPtr factory = IntPtr.Zero;
                IntPtr adapter = IntPtr.Zero;
                IntPtr output = IntPtr.Zero;
                try
                {
                    Guid iidFactory1 = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
                    if (SN.CreateDXGIFactory1(ref iidFactory1, out factory) != 0 || factory == IntPtr.Zero) return false;

                    var enumAdapters = ComFn<DxEnumAdapters1Del>(factory, 12);
                    for (uint a = 0; a < 16 && output == IntPtr.Zero; a++)
                    {
                        IntPtr pAdapter;
                        if (enumAdapters(factory, a, out pAdapter) != 0 || pAdapter == IntPtr.Zero) break;
                        var enumOutputs = ComFn<DxEnumOutputsDel>(pAdapter, 7);
                        for (uint o = 0; o < 16; o++)
                        {
                            IntPtr pOutput;
                            if (enumOutputs(pAdapter, o, out pOutput) != 0 || pOutput == IntPtr.Zero) break;
                            DxgiOutputDesc d;
                            bool match = false;
                            if (ComFn<DxGetOutputDescDel>(pOutput, 7)(pOutput, out d) == 0)
                            {
                                int w = d.DesktopCoordinates.Right - d.DesktopCoordinates.Left;
                                int h = d.DesktopCoordinates.Bottom - d.DesktopCoordinates.Top;
                                match = d.DesktopCoordinates.Left == monX && d.DesktopCoordinates.Top == monY &&
                                        w == monW && h == monH && (d.Rotation <= 1);
                            }
                            if (match)
                            {
                                output = pOutput;
                                adapter = pAdapter;
                                break;
                            }
                            Marshal.Release(pOutput);
                        }
                        if (output == IntPtr.Zero) Marshal.Release(pAdapter);
                    }
                    if (output == IntPtr.Zero) return false;

                    int fl;
                    // D3D_DRIVER_TYPE_UNKNOWN (adapter given), BGRA support flag
                    if (SN.D3D11CreateDevice(adapter, 0, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out device, out fl, out context) != 0 ||
                        device == IntPtr.Zero || context == IntPtr.Zero)
                    {
                        return false;
                    }

                    Guid iidOutput1 = new Guid("00cddea8-939b-4b83-a340-a685226666cc");
                    IntPtr output1;
                    if (Marshal.QueryInterface(output, ref iidOutput1, out output1) != 0 || output1 == IntPtr.Zero) return false;
                    int hr = ComFn<DxDuplicateOutputDel>(output1, 22)(output1, device, out dupl);
                    Marshal.Release(output1);
                    if (hr != 0 || dupl == IntPtr.Zero) { dupl = IntPtr.Zero; return false; }

                    D3DTexDesc td = new D3DTexDesc
                    {
                        Width = (uint)monW,
                        Height = (uint)monH,
                        MipLevels = 1,
                        ArraySize = 1,
                        Format = 87, // B8G8R8A8_UNORM
                        SampleCount = 1,
                        Usage = 3, // STAGING
                        CPUAccessFlags = 0x20000 // READ
                    };
                    if (ComFn<DxCreateTex2DDel>(device, 5)(device, ref td, IntPtr.Zero, out staging) != 0 || staging == IntPtr.Zero)
                    {
                        staging = IntPtr.Zero;
                        Dispose();
                        return false;
                    }

                    width = monW;
                    height = monH;
                    acquire = ComFn<DxAcquireDel>(dupl, 8);
                    release = ComFn<DxReleaseFrameDel>(dupl, 14);
                    copy = ComFn<DxCopyResourceDel>(context, 47);
                    map = ComFn<DxMapDel>(context, 14);
                    unmap = ComFn<DxUnmapDel>(context, 15);
                    return true;
                }
                catch
                {
                    Dispose();
                    return false;
                }
                finally
                {
                    if (output != IntPtr.Zero) Marshal.Release(output);
                    if (adapter != IntPtr.Zero) Marshal.Release(adapter);
                    if (factory != IntPtr.Zero) Marshal.Release(factory);
                    if (dupl == IntPtr.Zero) Dispose();
                }
            }

            // Waits up to timeoutMs for a new desktop image. On success the image is resampled into dst (canvas space).
            public CaptureResult Capture(uint timeoutMs, IntPtr dst, int dstPitch, int dstW, int dstH)
            {
                if (dupl == IntPtr.Zero) return CaptureResult.Failed;
                DxgiFrameInfo fi;
                IntPtr res;
                int hr = acquire(dupl, timeoutMs, out fi, out res);
                if (hr == unchecked((int)0x887A0027)) return CaptureResult.NoChange; // WAIT_TIMEOUT
                if (hr != 0)
                {
                    Dispose(); // ACCESS_LOST (mode change, UAC, lock screen...) -> reinit on next request
                    return CaptureResult.Failed;
                }

                bool updated = false;
                try
                {
                    // The first frame after DuplicateOutput can be an empty (black) surface; only trust presented frames
                    if (fi.LastPresentTime != 0)
                    {
                        Guid iidTex = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");
                        IntPtr tex;
                        if (res != IntPtr.Zero && Marshal.QueryInterface(res, ref iidTex, out tex) == 0 && tex != IntPtr.Zero)
                        {
                            copy(context, staging, tex);
                            Marshal.Release(tex);
                            updated = true;
                        }
                    }
                }
                finally
                {
                    if (res != IntPtr.Zero) Marshal.Release(res);
                    release(dupl);
                }
                if (!updated) return CaptureResult.NoChange;

                D3DMapped m;
                if (map(context, staging, 0, 1, 0, out m) != 0 || m.pData == IntPtr.Zero) return CaptureResult.Failed;
                try
                {
                    BoxResample(m.pData, (int)m.RowPitch, width, height, dst, dstPitch, dstW, dstH);
                }
                finally
                {
                    unmap(context, staging, 0);
                }
                return CaptureResult.NewFrame;
            }

            public void Dispose()
            {
                ComRelease(ref staging);
                ComRelease(ref dupl);
                ComRelease(ref context);
                ComRelease(ref device);
            }
        }

        #endregion

        #region GDI capturer (fallback + "all monitors")

        private sealed class GdiCapturer : IDisposable
        {
            private IntPtr memDc, dib, oldObj, bits;
            private int width, height;

            public unsafe bool Initialize(int w, int h)
            {
                Dispose();
                IntPtr screenDc = SN.GetDC(IntPtr.Zero);
                IntPtr bmi = Marshal.AllocHGlobal(44);
                try
                {
                    var hdr = new SN.BITMAPINFOHEADER
                    {
                        biSize = 40,
                        biWidth = w,
                        biHeight = -h,
                        biPlanes = 1,
                        biBitCount = 32,
                        biCompression = 0
                    };
                    Marshal.StructureToPtr(hdr, bmi, false);
                    memDc = SN.CreateCompatibleDC(screenDc);
                    dib = SN.CreateDIBSection(screenDc, bmi, 0, out bits, IntPtr.Zero, 0);
                    if (memDc == IntPtr.Zero || dib == IntPtr.Zero || bits == IntPtr.Zero)
                    {
                        Dispose();
                        return false;
                    }
                    oldObj = SN.SelectObject(memDc, dib);
                    width = w;
                    height = h;
                    return true;
                }
                finally
                {
                    Marshal.FreeHGlobal(bmi);
                    SN.ReleaseDC(IntPtr.Zero, screenDc);
                }
            }

            public CaptureResult Capture(int srcX, int srcY, IntPtr dst, int dstPitch, int dstW, int dstH)
            {
                if (memDc == IntPtr.Zero) return CaptureResult.Failed;
                IntPtr screenDc = SN.GetDC(IntPtr.Zero);
                try
                {
                    if (!SN.BitBlt(memDc, 0, 0, width, height, screenDc, srcX, srcY, 0x00CC0020)) return CaptureResult.Failed;
                }
                finally
                {
                    SN.ReleaseDC(IntPtr.Zero, screenDc);
                }
                BoxResample(bits, width * 4, width, height, dst, dstPitch, dstW, dstH);
                return CaptureResult.NewFrame;
            }

            public void Dispose()
            {
                if (memDc != IntPtr.Zero)
                {
                    if (oldObj != IntPtr.Zero) SN.SelectObject(memDc, oldObj);
                    SN.DeleteDC(memDc);
                }
                if (dib != IntPtr.Zero) SN.DeleteObject(dib);
                memDc = dib = oldObj = bits = IntPtr.Zero;
            }
        }

        #endregion

        #region Cursor shape extraction

        private sealed class CursorShape
        {
            public int HotX, HotY, Width, Height;
            public byte[] Png;
        }

        private static readonly Dictionary<IntPtr, CursorShape> cursorShapeCache = new Dictionary<IntPtr, CursorShape>();

        private static unsafe uint[] ReadBitmap32(IntPtr hbm, int w, int h)
        {
            uint[] px = new uint[w * h];
            IntPtr bmi = Marshal.AllocHGlobal(40 + 256 * 4);
            IntPtr dc = SN.GetDC(IntPtr.Zero);
            try
            {
                var hdr = new SN.BITMAPINFOHEADER { biSize = 40, biWidth = w, biHeight = -h, biPlanes = 1, biBitCount = 32 };
                Marshal.StructureToPtr(hdr, bmi, false);
                fixed (uint* p = px)
                {
                    if (SN.GetDIBits(dc, hbm, 0, (uint)h, (IntPtr)p, bmi, 0) == 0) return null;
                }
                return px;
            }
            finally
            {
                SN.ReleaseDC(IntPtr.Zero, dc);
                Marshal.FreeHGlobal(bmi);
            }
        }

        private static CursorShape GetCursorShape(IntPtr hCursor)
        {
            lock (cursorShapeCache)
            {
                CursorShape cached;
                if (cursorShapeCache.TryGetValue(hCursor, out cached)) return cached;
            }

            SN.ICONINFO_S ii;
            if (!SN.GetIconInfo(hCursor, out ii)) return null;
            CursorShape shape = null;
            try
            {
                SN.BITMAP_S bm;
                if (SN.GetObject(ii.hbmMask, Marshal.SizeOf(typeof(SN.BITMAP_S)), out bm) == 0) return null;
                int w = bm.bmWidth;
                int h = ii.hbmColor == IntPtr.Zero ? bm.bmHeight / 2 : bm.bmHeight;
                if (w <= 0 || h <= 0 || w > 256 || h > 256) return null;

                uint[] argb = new uint[w * h];
                if (ii.hbmColor != IntPtr.Zero)
                {
                    uint[] color = ReadBitmap32(ii.hbmColor, w, h);
                    uint[] mask = ReadBitmap32(ii.hbmMask, w, h);
                    if (color == null) return null;
                    bool hasAlpha = false;
                    for (int i = 0; i < color.Length; i++) { if ((color[i] & 0xFF000000u) != 0) { hasAlpha = true; break; } }
                    for (int i = 0; i < color.Length; i++)
                    {
                        if (hasAlpha) argb[i] = color[i];
                        else
                        {
                            bool transparent = mask != null && (mask[i] & 0x00FFFFFFu) != 0;
                            argb[i] = transparent ? 0u : (0xFF000000u | (color[i] & 0x00FFFFFFu));
                        }
                    }
                }
                else
                {
                    uint[] mask = ReadBitmap32(ii.hbmMask, w, h * 2);
                    if (mask == null) return null;
                    bool[] invert = new bool[w * h];
                    for (int i = 0; i < w * h; i++)
                    {
                        bool and = (mask[i] & 0x00FFFFFFu) != 0;
                        bool xor = (mask[i + w * h] & 0x00FFFFFFu) != 0;
                        if (!and) argb[i] = xor ? 0xFFFFFFFFu : 0xFF000000u;
                        else if (xor) { argb[i] = 0xFF000000u; invert[i] = true; }
                        else argb[i] = 0;
                    }
                    // Inverting cursors (I-beam) get a light halo so they stay visible on dark backgrounds
                    for (int y = 0; y < h; y++)
                    {
                        for (int x = 0; x < w; x++)
                        {
                            int i = y * w + x;
                            if (argb[i] != 0) continue;
                            bool near = (x > 0 && invert[i - 1]) || (x < w - 1 && invert[i + 1]) ||
                                        (y > 0 && invert[i - w]) || (y < h - 1 && invert[i + w]);
                            if (near) argb[i] = 0xD0FFFFFFu;
                        }
                    }
                }

                using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
                {
                    var bd = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
                    try
                    {
                        int[] signed = new int[argb.Length];
                        Buffer.BlockCopy(argb, 0, signed, 0, argb.Length * 4);
                        for (int y = 0; y < h; y++)
                        {
                            Marshal.Copy(signed, y * w, bd.Scan0 + y * bd.Stride, w);
                        }
                    }
                    finally
                    {
                        bmp.UnlockBits(bd);
                    }
                    using (var ms = new MemoryStream())
                    {
                        bmp.Save(ms, ImageFormat.Png);
                        shape = new CursorShape { HotX = ii.xHotspot, HotY = ii.yHotspot, Width = w, Height = h, Png = ms.ToArray() };
                    }
                }
            }
            catch
            {
                shape = null;
            }
            finally
            {
                if (ii.hbmMask != IntPtr.Zero) SN.DeleteObject(ii.hbmMask);
                if (ii.hbmColor != IntPtr.Zero) SN.DeleteObject(ii.hbmColor);
            }

            if (shape != null)
            {
                lock (cursorShapeCache)
                {
                    if (cursorShapeCache.Count > 64) cursorShapeCache.Clear();
                    cursorShapeCache[hCursor] = shape;
                }
            }
            return shape;
        }

        #endregion

        #region Streaming session

        private sealed class StreamRequest
        {
            public int MonitorIndex;
            public int MaxCanvasWidth;
            public double MotionScale;
            public int MotionQuality;
            public int RefineQuality;
            public int Mode;
            public bool Motion444;
            public int WaitMs;
            public bool AllowVideo;
            public bool AllowAv1;
            public int VideoKbps;
            public int VideoMaxWidth;
            public int Fps;
        }

        private struct TileRect
        {
            public int X, Y, W, H;
        }

        private sealed class ScreenStreamSession : IDisposable
        {
            private const int TILE = 64;

            private readonly TcpClient client;
            private NetworkStream ns;
            private readonly MemoryStream outMs = new MemoryStream(1 << 20);
            private readonly ThreadLocal<JpegEncoder> encoders = new ThreadLocal<JpegEncoder>(() => new JpegEncoder(), true);
            private readonly ThreadLocal<ScratchBuf> scratch = new ThreadLocal<ScratchBuf>(() => new ScratchBuf(), true);

            private int monitorIndex = int.MinValue;
            private int maxCanvasWidth = -1;
            private int srcX, srcY, srcW, srcH;
            private int canvasW, canvasH, pitch;
            private IntPtr curBuf = IntPtr.Zero, prevBuf = IntPtr.Zero;
            private bool hasPrev;
            private int tilesX, tilesY;
            private bool[] dirty;
            private bool[] lowQ;
            private int lowQCount;

            private readonly DxgiCapturer dxgi = new DxgiCapturer();
            private readonly GdiCapturer gdi = new GdiCapturer();
            private bool gdiReady;
            private int dxgiFailures;
            private long nextDxgiRetryTick;
            private long lastMonitorCheckTick;
            private string lastAttachedDesktopName = "";

            private uint frameId;
            private IntPtr lastCursorHandle = IntPtr.Zero;
            private int lastCurX = int.MinValue, lastCurY = int.MinValue;
            private bool lastCurVisible;
            private bool forceShape = true;

            private H264Encoder video;
            private bool videoFailed;
            private bool av1Failed;
            private bool videoNeedsIdr = true;
            private IntPtr nv12Buf = IntPtr.Zero;
            private int nv12Size;
            private IntPtr videoScaleBuf = IntPtr.Zero;
            private int videoScaleSize;

            private sealed class ScratchBuf
            {
                public IntPtr Ptr = IntPtr.Zero;
                public int Size;
                public IntPtr Get(int need)
                {
                    if (Size < need)
                    {
                        if (Ptr != IntPtr.Zero) Marshal.FreeHGlobal(Ptr);
                        Size = need;
                        Ptr = Marshal.AllocHGlobal(need);
                    }
                    return Ptr;
                }
            }

            public ScreenStreamSession(TcpClient c)
            {
                client = c;
            }

            public void Run()
            {
                try
                {
                    try { SN.SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { } // PER_MONITOR_AWARE_V2 -> physical pixels
                    try { SN.CoInitializeEx(IntPtr.Zero, 0); } catch { }
                    try { SN.timeBeginPeriod(1); } catch { }
                    client.NoDelay = true;
                    client.SendBufferSize = 1 << 20;
                    ns = client.GetStream();
                    if (!CheckIpcKey(ns)) return;
                    byte[] req = new byte[24];
                    while (true)
                    {
                        int got = 0;
                        while (got < req.Length)
                        {
                            int r = ns.Read(req, got, req.Length - got);
                            if (r <= 0) return;
                            got += r;
                        }
                        if (BitConverter.ToUInt32(req, 0) != STREAM_REQ_MAGIC) return;
                        var sr = new StreamRequest
                        {
                            MonitorIndex = BitConverter.ToInt32(req, 4),
                            MaxCanvasWidth = Math.Max(640, Math.Min(7680, (int)BitConverter.ToUInt16(req, 8))),
                            MotionScale = Math.Max(0.25, Math.Min(1.0, BitConverter.ToUInt16(req, 10) / 1000.0)),
                            MotionQuality = Math.Max(20, Math.Min(95, (int)req[12])),
                            RefineQuality = Math.Max(40, Math.Min(98, (int)req[13])),
                            Mode = req[14],
                            Motion444 = (req[15] & 1) != 0,
                            WaitMs = Math.Max(0, Math.Min(1000, (int)BitConverter.ToUInt16(req, 16))),
                            AllowVideo = (req[15] & 2) != 0,
                            AllowAv1 = (req[15] & 4) != 0,
                            VideoKbps = Math.Max(500, Math.Min(60000, BitConverter.ToUInt16(req, 18) * 100)),
                            VideoMaxWidth = Math.Max(640, Math.Min(3840, (int)BitConverter.ToUInt16(req, 20))),
                            Fps = Math.Max(10, Math.Min(60, (int)BitConverter.ToUInt16(req, 22)))
                        };
                        ProduceFrame(sr);
                        ns.Write(outMs.GetBuffer(), 0, (int)outMs.Length);
                    }
                }
                catch { }
                finally
                {
                    try { SN.timeEndPeriod(1); } catch { }
                }
            }

            private void ResolveSourceRect(int index, out int x, out int y, out int w, out int h)
            {
                if (index < 0)
                {
                    x = SN.GetSystemMetrics(76);
                    y = SN.GetSystemMetrics(77);
                    w = SN.GetSystemMetrics(78);
                    h = SN.GetSystemMetrics(79);
                    return;
                }
                var mons = new List<SN.MONITORINFOEX>();
                SN.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr hMon, IntPtr hdc, ref RECT rc, IntPtr data) =>
                {
                    var mi = new SN.MONITORINFOEX();
                    mi.cbSize = Marshal.SizeOf(typeof(SN.MONITORINFOEX));
                    if (SN.GetMonitorInfo(hMon, ref mi)) mons.Add(mi);
                    return true;
                }, IntPtr.Zero);
                // Same ordering as GetMonitorsList(): primary first, then left-to-right, then top-to-bottom
                mons.Sort((a, b) =>
                {
                    bool pa = (a.dwFlags & 1) != 0, pb = (b.dwFlags & 1) != 0;
                    if (pa != pb) return pa ? -1 : 1;
                    if (a.rcMonitor.Left != b.rcMonitor.Left) return a.rcMonitor.Left.CompareTo(b.rcMonitor.Left);
                    return a.rcMonitor.Top.CompareTo(b.rcMonitor.Top);
                });
                if (mons.Count == 0)
                {
                    x = 0; y = 0; w = SN.GetSystemMetrics(0); h = SN.GetSystemMetrics(1);
                    return;
                }
                var m = mons[index < mons.Count ? index : 0];
                x = m.rcMonitor.Left;
                y = m.rcMonitor.Top;
                w = Math.Max(1, m.rcMonitor.Right - m.rcMonitor.Left);
                h = Math.Max(1, m.rcMonitor.Bottom - m.rcMonitor.Top);
            }

            private void EnsureGeometry(StreamRequest r)
            {
                long now = Environment.TickCount;
                bool recheck = r.MonitorIndex != monitorIndex || r.MaxCanvasWidth != maxCanvasWidth ||
                               Math.Abs(now - lastMonitorCheckTick) > 2000 || curBuf == IntPtr.Zero;
                if (!recheck) return;
                lastMonitorCheckTick = now;

                int x, y, w, h;
                ResolveSourceRect(r.MonitorIndex, out x, out y, out w, out h);
                if (r.MonitorIndex == monitorIndex && r.MaxCanvasWidth == maxCanvasWidth &&
                    x == srcX && y == srcY && w == srcW && h == srcH && curBuf != IntPtr.Zero)
                {
                    return;
                }

                monitorIndex = r.MonitorIndex;
                maxCanvasWidth = r.MaxCanvasWidth;
                srcX = x; srcY = y; srcW = w; srcH = h;

                double cs = srcW > maxCanvasWidth ? (double)maxCanvasWidth / srcW : 1.0;
                canvasW = Math.Max(16, (int)Math.Round(srcW * cs)) & ~1;
                canvasH = Math.Max(16, (int)Math.Round(srcH * cs)) & ~1;
                pitch = canvasW * 4;

                if (curBuf != IntPtr.Zero) Marshal.FreeHGlobal(curBuf);
                if (prevBuf != IntPtr.Zero) Marshal.FreeHGlobal(prevBuf);
                curBuf = Marshal.AllocHGlobal(pitch * canvasH);
                prevBuf = Marshal.AllocHGlobal(pitch * canvasH);
                hasPrev = false;

                tilesX = (canvasW + TILE - 1) / TILE;
                tilesY = (canvasH + TILE - 1) / TILE;
                dirty = new bool[tilesX * tilesY];
                lowQ = new bool[tilesX * tilesY];
                lowQCount = 0;

                dxgi.Dispose();
                dxgiFailures = 0;
                nextDxgiRetryTick = 0;
                gdiReady = false;
                forceShape = true;
            }

            private long lastDesktopSyncTick = 0;

            private CaptureResult CaptureOnce(int waitMs, bool needImage)
            {
                long now = Environment.TickCount;
                // When DXGI is active, desktop switches report ACCESS_LOST immediately; avoid 4 kernel syscalls per frame
                if (!dxgi.IsReady || (uint)(now - lastDesktopSyncTick) > 1000)
                {
                    lastDesktopSyncTick = now;
                    string currentDesktop;
                    if (SyncThreadToInputDesktop(out currentDesktop) && !string.IsNullOrEmpty(currentDesktop))
                    {
                        if (!string.Equals(currentDesktop, lastAttachedDesktopName, StringComparison.OrdinalIgnoreCase))
                        {
                            lastAttachedDesktopName = currentDesktop;
                            dxgi.Dispose();
                            dxgiFailures = 0;
                            nextDxgiRetryTick = 0;
                            gdi.Dispose();
                            gdiReady = false;
                            forceShape = true;
                            hasPrev = false;
                            videoNeedsIdr = true;
                        }
                    }
                }
                if (monitorIndex >= 0 && !dxgi.IsReady && now >= nextDxgiRetryTick)
                {
                    if (!dxgi.Initialize(srcX, srcY, srcW, srcH))
                    {
                        dxgiFailures++;
                        nextDxgiRetryTick = now + Math.Min(5000, 250 * dxgiFailures);
                    }
                    else
                    {
                        dxgiFailures = 0;
                    }
                }

                if (dxgi.IsReady)
                {
                    var res = dxgi.Capture((uint)Math.Max(0, waitMs), curBuf, pitch, canvasW, canvasH);
                    if (res == CaptureResult.NewFrame) return res;
                    if (res == CaptureResult.NoChange && !needImage) return res;
                    // fall through to GDI when DXGI failed or we need an initial image right now
                    if (res == CaptureResult.NoChange && needImage && hasPrev) return res;
                }
                else if (waitMs > 0)
                {
                    // GDI has no change notification: poll at ~60 Hz
                    Thread.Sleep(Math.Min(waitMs, 16));
                }

                if (!gdiReady) gdiReady = gdi.Initialize(srcW, srcH);
                if (!gdiReady) return CaptureResult.Failed;
                return gdi.Capture(srcX, srcY, curBuf, pitch, canvasW, canvasH);
            }

            private unsafe int DiffTiles(bool all)
            {
                int count = 0;
                if (all || !hasPrev)
                {
                    for (int i = 0; i < dirty.Length; i++) dirty[i] = true;
                    return dirty.Length;
                }
                IntPtr cur = curBuf, prev = prevBuf;
                int p = pitch, cw = canvasW, ch = canvasH, tx = tilesX;
                bool[] d = dirty;
                Parallel.For(0, tilesY, ty =>
                {
                    int y0 = ty * TILE;
                    int y1 = Math.Min(ch, y0 + TILE);
                    int rowBase = ty * tx;
                    for (int t = 0; t < tx; t++) d[rowBase + t] = false;
                    for (int y = y0; y < y1; y++)
                    {
                        byte* cRow = (byte*)cur + (long)y * p;
                        byte* pRow = (byte*)prev + (long)y * p;
                        for (int t = 0; t < tx; t++)
                        {
                            if (d[rowBase + t]) continue;
                            int x0 = t * TILE;
                            int bytes = Math.Min(TILE, cw - x0) * 4;
                            ulong* a = (ulong*)(cRow + x0 * 4);
                            ulong* b = (ulong*)(pRow + x0 * 4);
                            int n = bytes >> 3;
                            for (int k = 0; k < n; k++)
                            {
                                if (a[k] != b[k]) { d[rowBase + t] = true; break; }
                            }
                        }
                    }
                });
                for (int i = 0; i < d.Length; i++) if (d[i]) count++;
                return count;
            }

            private List<TileRect> BuildRects(bool[] mask, int maskCount)
            {
                var rects = new List<TileRect>();
                if (maskCount == 0) return rects;
                if (maskCount * 100 >= mask.Length * 55)
                {
                    rects.Add(new TileRect { X = 0, Y = 0, W = canvasW, H = canvasH });
                    return rects;
                }
                bool[] used = new bool[mask.Length];
                int minTx = int.MaxValue, minTy = int.MaxValue, maxTx = -1, maxTy = -1;
                for (int ty = 0; ty < tilesY; ty++)
                {
                    for (int tx = 0; tx < tilesX; tx++)
                    {
                        int i = ty * tilesX + tx;
                        if (!mask[i] || used[i]) continue;
                        int tx2 = tx;
                        while (tx2 + 1 < tilesX && mask[ty * tilesX + tx2 + 1] && !used[ty * tilesX + tx2 + 1]) tx2++;
                        int ty2 = ty;
                        while (ty2 + 1 < tilesY)
                        {
                            bool full = true;
                            for (int k = tx; k <= tx2; k++)
                            {
                                int j = (ty2 + 1) * tilesX + k;
                                if (!mask[j] || used[j]) { full = false; break; }
                            }
                            if (!full) break;
                            ty2++;
                        }
                        for (int yy = ty; yy <= ty2; yy++)
                            for (int xx = tx; xx <= tx2; xx++)
                                used[yy * tilesX + xx] = true;
                        int px = tx * TILE, py = ty * TILE;
                        rects.Add(new TileRect
                        {
                            X = px,
                            Y = py,
                            W = Math.Min(canvasW, (tx2 + 1) * TILE) - px,
                            H = Math.Min(canvasH, (ty2 + 1) * TILE) - py
                        });
                        minTx = Math.Min(minTx, tx); minTy = Math.Min(minTy, ty);
                        maxTx = Math.Max(maxTx, tx2); maxTy = Math.Max(maxTy, ty2);
                    }
                }
                if (rects.Count > 40)
                {
                    int px = minTx * TILE, py = minTy * TILE;
                    rects.Clear();
                    rects.Add(new TileRect
                    {
                        X = px,
                        Y = py,
                        W = Math.Min(canvasW, (maxTx + 1) * TILE) - px,
                        H = Math.Min(canvasH, (maxTy + 1) * TILE) - py
                    });
                }
                return rects;
            }

            // Large rectangles are split into horizontal bands (multiples of 64px) so they encode in parallel.
            private List<TileRect> SplitForParallelism(List<TileRect> rects)
            {
                int cores = Math.Max(1, Math.Min(8, Environment.ProcessorCount));
                var result = new List<TileRect>();
                foreach (var r in rects)
                {
                    long area = (long)r.W * r.H;
                    int bands = (int)Math.Min(cores, area / 200000);
                    if (bands <= 1 || r.H < TILE * 2)
                    {
                        result.Add(r);
                        continue;
                    }
                    int tileRows = (r.H + TILE - 1) / TILE;
                    bands = Math.Min(bands, tileRows);
                    int rowsPerBand = (tileRows + bands - 1) / bands;
                    for (int y = r.Y; y < r.Y + r.H; y += rowsPerBand * TILE)
                    {
                        int h = Math.Min(rowsPerBand * TILE, r.Y + r.H - y);
                        result.Add(new TileRect { X = r.X, Y = y, W = r.W, H = h });
                    }
                }
                return result;
            }

            private byte[] EncodeRect(TileRect r, double scale, int quality, bool chroma444)
            {
                IntPtr src = prevBuf + r.Y * pitch + r.X * 4;
                var enc = encoders.Value;
                if (scale >= 0.999)
                {
                    return enc.Encode(src, pitch, r.W, r.H, quality, chroma444);
                }
                int dw = Math.Max(1, (int)Math.Round(r.W * scale));
                int dh = Math.Max(1, (int)Math.Round(r.H * scale));
                IntPtr tmp = scratch.Value.Get(dw * dh * 4);
                BoxResample(src, pitch, r.W, r.H, tmp, dw * 4, dw, dh);
                return enc.Encode(tmp, dw * 4, dw, dh, quality, chroma444);
            }

            private bool PollCursor(out int cx, out int cy, out bool visible, out CursorShape shapeToSend)
            {
                shapeToSend = null;
                var ci = new SN.CURSORINFO_S();
                ci.cbSize = Marshal.SizeOf(typeof(SN.CURSORINFO_S));
                visible = false;
                cx = lastCurX; cy = lastCurY;
                if (!SN.GetCursorInfo(ref ci)) return false;
                visible = (ci.flags & 1) != 0 && ci.hCursor != IntPtr.Zero;
                cx = ci.x; cy = ci.y;
                bool changed = cx != lastCurX || cy != lastCurY || visible != lastCurVisible;
                if (visible && (ci.hCursor != lastCursorHandle || forceShape))
                {
                    shapeToSend = GetCursorShape(ci.hCursor);
                    lastCursorHandle = ci.hCursor;
                    forceShape = shapeToSend == null;
                    changed = true;
                }
                return changed;
            }

            private readonly Stopwatch frameClock = Stopwatch.StartNew();
            private long lastFrameMs = -1000;

            private void ProduceFrame(StreamRequest r)
            {
                // When DXGI is active at 60 FPS, AcquireNextFrame already blocks until the display's VSync;
                // pre-sleeping with Thread.Sleep(1) can overshoot the VSync edge and drop 60 FPS down to 30 FPS.
                if (r.Mode == 0 && (!dxgi.IsReady || r.Fps < 55))
                {
                    long minGap = 750 / Math.Max(10, r.Fps);
                    while (frameClock.ElapsedMilliseconds - lastFrameMs < minGap) Thread.Sleep(1);
                }
                var sw = Stopwatch.StartNew();
                EnsureGeometry(r);

                bool key = r.Mode == 2 || !hasPrev;
                bool refine = r.Mode == 1 && !key;
                if (key) forceShape = true;

                int dirtyCount = 0;
                bool haveNewImage = false;
                long captureMs = frameClock.ElapsedMilliseconds;
                int cx = 0, cy = 0;
                bool visible = false;
                CursorShape shape = null;
                bool cursorChanged = false;

                int waitBudget = (key || refine) ? 0 : r.WaitMs;
                while (true)
                {
                    int remaining = Math.Max(0, waitBudget - (int)sw.ElapsedMilliseconds);
                    int slice = Math.Min(remaining, 16);
                    var res = CaptureOnce(key ? 50 : slice, key);
                    if (res == CaptureResult.NewFrame)
                    {
                        haveNewImage = true;
                        captureMs = frameClock.ElapsedMilliseconds;
                        dirtyCount = DiffTiles(key);
                    }

                    CursorShape s;
                    if (PollCursor(out cx, out cy, out visible, out s)) cursorChanged = true;
                    if (s != null) shape = s;

                    if (key) break;
                    if (dirtyCount > 0 || cursorChanged || refine) break;
                    if (sw.ElapsedMilliseconds >= waitBudget) break;
                }

                if (haveNewImage)
                {
                    IntPtr t = prevBuf; prevBuf = curBuf; curBuf = t;
                    hasPrev = true;
                }
                if (!hasPrev)
                {
                    // Nothing could be captured (secure desktop / transient failure): send an empty frame
                    key = false;
                    dirtyCount = 0;
                }
                else if (key)
                {
                    dirtyCount = DiffTiles(true);
                }

                // Decide what to encode
                bool[] mask = dirty;
                int maskCount = dirtyCount;
                double scale = r.MotionScale;
                int quality = r.MotionQuality;
                bool chroma444 = r.Motion444;
                if (refine)
                {
                    mask = new bool[dirty.Length];
                    maskCount = 0;
                    for (int i = 0; i < mask.Length; i++)
                    {
                        mask[i] = (dirtyCount > 0 && dirty[i]) || lowQ[i];
                        if (mask[i]) maskCount++;
                    }
                    scale = 1.0;
                    quality = r.RefineQuality;
                    chroma444 = true;
                }
                bool fullQuality = scale >= 0.999 && quality >= r.RefineQuality && chroma444;

                // Motion goes through H.264 (like CRD's video channel); top-off and fallback stay JPEG
                byte[] videoAu = null;
                bool videoKey = false;
                if (r.AllowVideo && !videoFailed && !refine && maskCount > 0)
                {
                    videoAu = EncodeVideoFrame(r, key, out videoKey);
                    if (videoAu == null) videoFailed = true;
                }

                List<TileRect> rects;
                byte[][] encoded;
                if (videoAu != null)
                {
                    rects = key ? new List<TileRect> { new TileRect { X = 0, Y = 0, W = canvasW, H = canvasH } } : BuildRects(mask, maskCount);
                    encoded = new byte[rects.Count][];
                    fullQuality = false;
                }
                else
                {
                    rects = SplitForParallelism(BuildRects(mask, maskCount));
                    encoded = new byte[rects.Count][];
                    if (rects.Count == 1)
                    {
                        encoded[0] = EncodeRect(rects[0], scale, quality, chroma444);
                    }
                    else if (rects.Count > 1)
                    {
                        Parallel.For(0, rects.Count, i => { encoded[i] = EncodeRect(rects[i], scale, quality, chroma444); });
                    }
                }

                // Track which tiles still need a sharp "top-off" pass
                if (maskCount > 0)
                {
                    lowQCount = 0;
                    for (int i = 0; i < lowQ.Length; i++)
                    {
                        if (mask[i]) lowQ[i] = !fullQuality;
                        if (lowQ[i]) lowQCount++;
                    }
                }

                int flags = 0;
                if (key) flags |= FRAME_FLAG_KEY;
                if (refine) flags |= FRAME_FLAG_REFINE;
                bool cursorOnSource = cx >= srcX && cx < srcX + srcW && cy >= srcY && cy < srcY + srcH;
                if (visible && cursorOnSource) flags |= FRAME_FLAG_CURSOR_VISIBLE;
                if (shape != null) flags |= FRAME_FLAG_CURSOR_SHAPE;
                if (rects.Count == 0) flags |= FRAME_FLAG_IDLE;
                if (lowQCount > 0) flags |= FRAME_FLAG_PENDING_REFINE;
                if (dxgi.IsReady) flags |= FRAME_FLAG_DXGI;
                if (videoAu != null) flags |= FRAME_FLAG_VIDEO;
                if (videoAu != null && videoKey) flags |= FRAME_FLAG_VIDEO_KEY;
                if (videoAu != null && video.IsAv1) flags |= FRAME_FLAG_VIDEO_AV1;

                lastCurX = cx; lastCurY = cy; lastCurVisible = visible;
                double nx = srcW > 0 ? (double)(cx - srcX) / srcW : 0.5;
                double ny = srcH > 0 ? (double)(cy - srcY) / srcH : 0.5;

                outMs.SetLength(0);
                var bw = new BinaryWriter(outMs);
                bw.Write(STREAM_FRAME_MAGIC);
                bw.Write(++frameId);
                bw.Write((ushort)flags);
                bw.Write((ushort)rects.Count);
                bw.Write((ushort)canvasW);
                bw.Write((ushort)canvasH);
                bw.Write((ushort)Math.Min(65535, srcW));
                bw.Write((ushort)Math.Min(65535, srcH));
                bw.Write((ushort)Math.Max(0, Math.Min(65535, Math.Round(nx * 65535))));
                bw.Write((ushort)Math.Max(0, Math.Min(65535, Math.Round(ny * 65535))));
                bw.Write((ushort)Math.Min(65535, sw.ElapsedMilliseconds));
                bw.Write((ushort)lastInputSeq);
                if (shape != null)
                {
                    bw.Write((ushort)shape.HotX);
                    bw.Write((ushort)shape.HotY);
                    bw.Write((ushort)shape.Width);
                    bw.Write((ushort)shape.Height);
                    bw.Write((uint)shape.Png.Length);
                    bw.Write(shape.Png);
                }
                if (videoAu != null)
                {
                    bw.Write((ushort)video.Width);
                    bw.Write((ushort)video.Height);
                    bw.Write((uint)videoAu.Length);
                    bw.Write(videoAu);
                }
                for (int i = 0; i < rects.Count; i++)
                {
                    byte[] jpg = encoded[i] ?? new byte[0];
                    bw.Write((ushort)rects[i].X);
                    bw.Write((ushort)rects[i].Y);
                    bw.Write((ushort)rects[i].W);
                    bw.Write((ushort)rects[i].H);
                    bw.Write((uint)jpg.Length);
                    bw.Write(jpg);
                }
                bw.Flush();
                if (rects.Count > 0) lastFrameMs = captureMs; // cap is measured capture-to-capture
            }

            private byte[] EncodeVideoFrame(StreamRequest r, bool forceKey, out bool isKey)
            {
                isKey = false;
                double vs = canvasW > r.VideoMaxWidth ? (double)r.VideoMaxWidth / canvasW : 1.0;
                int vw = Math.Max(64, (int)Math.Round(canvasW * vs)) & ~1;
                int vh = Math.Max(64, (int)Math.Round(canvasH * vs)) & ~1;
                try
                {
                    if (video == null) video = new H264Encoder();
                    bool wantAv1 = r.AllowAv1 && !av1Failed;
                    if (!video.IsReady || video.Width != vw || video.Height != vh || video.Fps != r.Fps || video.IsAv1 != wantAv1)
                    {
                        bool ready = video.Initialize(vw, vh, r.Fps, r.VideoKbps, wantAv1);
                        if (!ready && wantAv1)
                        {
                            av1Failed = true; // no AV1 encoder on this GPU: H.264 for the rest of the session
                            ready = video.Initialize(vw, vh, r.Fps, r.VideoKbps, false);
                        }
                        if (!ready && vw > 1920)
                        {
                            // Fallback for software MFT encoders capped at 1920x1088
                            r.VideoMaxWidth = 1920;
                            double vsFallback = canvasW > 1920 ? 1920.0 / canvasW : 1.0;
                            vw = Math.Max(64, (int)Math.Round(canvasW * vsFallback)) & ~1;
                            vh = Math.Max(64, (int)Math.Round(canvasH * vsFallback)) & ~1;
                            ready = video.Initialize(vw, vh, r.Fps, r.VideoKbps, false);
                        }
                        if (!ready) return null;
                        videoNeedsIdr = true;
                    }
                    video.SetBitrate(r.VideoKbps);

                    IntPtr src = prevBuf;
                    int srcPitch = pitch;
                    if (vw != canvasW || vh != canvasH)
                    {
                        if (videoScaleSize < vw * vh * 4)
                        {
                            if (videoScaleBuf != IntPtr.Zero) Marshal.FreeHGlobal(videoScaleBuf);
                            videoScaleSize = vw * vh * 4;
                            videoScaleBuf = Marshal.AllocHGlobal(videoScaleSize);
                        }
                        BoxResample(prevBuf, pitch, canvasW, canvasH, videoScaleBuf, vw * 4, vw, vh);
                        src = videoScaleBuf;
                        srcPitch = vw * 4;
                    }
                    if (nv12Size < vw * vh * 3 / 2)
                    {
                        if (nv12Buf != IntPtr.Zero) Marshal.FreeHGlobal(nv12Buf);
                        nv12Size = vw * vh * 3 / 2;
                        nv12Buf = Marshal.AllocHGlobal(nv12Size);
                    }
                    BgraToNv12(src, srcPitch, vw, vh, nv12Buf);
                    byte[] au = video.Encode(nv12Buf, forceKey || videoNeedsIdr, out isKey);
                    if (au != null && (forceKey || videoNeedsIdr) && !isKey) isKey = video.IsAv1 ? ContainsAv1SequenceHeader(au) : ContainsIdr(au);
                    if (au != null) videoNeedsIdr = false;
                    return au;
                }
                catch
                {
                    return null;
                }
            }

            // AV1 encoders repeat the sequence header OBU on every key frame
            private static bool ContainsAv1SequenceHeader(byte[] tu)
            {
                int i = 0;
                while (i < tu.Length)
                {
                    int header = tu[i];
                    int type = (header >> 3) & 0x0F;
                    bool hasExt = (header & 0x04) != 0;
                    bool hasSize = (header & 0x02) != 0;
                    if (type == 1) return true;
                    if (!hasSize) return false;
                    int p = i + 1 + (hasExt ? 1 : 0);
                    long size = 0;
                    for (int k = 0; k < 8 && p < tu.Length; k++)
                    {
                        byte v = tu[p++];
                        size |= (long)(v & 0x7F) << (7 * k);
                        if ((v & 0x80) == 0) break;
                    }
                    if (size < 0 || p + size > tu.Length) return false;
                    i = p + (int)size;
                }
                return false;
            }

            private static bool ContainsIdr(byte[] au)
            {
                for (int i = 0; i + 4 < au.Length; i++)
                {
                    if (au[i] == 0 && au[i + 1] == 0 && au[i + 2] == 1 && (au[i + 3] & 0x1F) == 5) return true;
                }
                return false;
            }

            public void Dispose()
            {
                try { client.Close(); } catch { }
                if (video != null) { try { video.Dispose(); } catch { } video = null; }
                if (nv12Buf != IntPtr.Zero) { Marshal.FreeHGlobal(nv12Buf); nv12Buf = IntPtr.Zero; }
                if (videoScaleBuf != IntPtr.Zero) { Marshal.FreeHGlobal(videoScaleBuf); videoScaleBuf = IntPtr.Zero; }
                dxgi.Dispose();
                gdi.Dispose();
                foreach (var e in encoders.Values) { try { e.Dispose(); } catch { } }
                foreach (var s in scratch.Values) { if (s.Ptr != IntPtr.Zero) Marshal.FreeHGlobal(s.Ptr); s.Ptr = IntPtr.Zero; }
                encoders.Dispose();
                scratch.Dispose();
                if (curBuf != IntPtr.Zero) { Marshal.FreeHGlobal(curBuf); curBuf = IntPtr.Zero; }
                if (prevBuf != IntPtr.Zero) { Marshal.FreeHGlobal(prevBuf); prevBuf = IntPtr.Zero; }
            }
        }

        #endregion
    }
}
