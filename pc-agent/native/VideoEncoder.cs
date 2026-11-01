using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

namespace TahaBLT
{
    // H.264 encoder for the remote desktop motion path (the role VP8/VP9/H.264 play in Chrome Remote Desktop).
    // Uses Media Foundation through raw vtables: a hardware MFT (NVENC / Quick Sync / AMF) when available,
    // otherwise Microsoft's software H.264 encoder. Output is Annex B (start codes, SPS/PPS on IDR frames),
    // which the phone decodes with WebCodecs VideoDecoder.
    public partial class Program
    {
        private static class MF
        {
            [StructLayout(LayoutKind.Sequential)]
            public struct RegisterTypeInfo
            {
                public Guid Major;
                public Guid Sub;
            }

            [StructLayout(LayoutKind.Sequential)]
            public struct OutputStreamInfo
            {
                public uint Flags;
                public uint Size;
                public uint Alignment;
            }

            [StructLayout(LayoutKind.Sequential)]
            public struct OutputDataBuffer
            {
                public uint StreamId;
                public IntPtr Sample;
                public uint Status;
                public IntPtr Events;
            }

            [DllImport("mfplat.dll")]
            public static extern int MFStartup(uint version, uint flags);

            [DllImport("mfplat.dll")]
            public static extern int MFTEnumEx(Guid category, uint flags, ref RegisterTypeInfo input, ref RegisterTypeInfo output, out IntPtr activates, out uint count);

            [DllImport("mfplat.dll")]
            public static extern int MFCreateMediaType(out IntPtr mediaType);

            [DllImport("mfplat.dll")]
            public static extern int MFCreateSample(out IntPtr sample);

            [DllImport("mfplat.dll")]
            public static extern int MFCreateMemoryBuffer(uint maxLength, out IntPtr buffer);

            public static readonly Guid CategoryVideoEncoder = new Guid("f79eac7d-e545-4387-bdee-d647d7bde42a");
            public static readonly Guid MediaTypeVideo = new Guid("73646976-0000-0010-8000-00AA00389B71");
            public static readonly Guid FormatH264 = new Guid("34363248-0000-0010-8000-00AA00389B71");
            public static readonly Guid FormatAV1 = new Guid("31305641-0000-0010-8000-00AA00389B71");
            public static readonly Guid FormatNV12 = new Guid("3231564E-0000-0010-8000-00AA00389B71");
            public static readonly Guid MajorType = new Guid("48eba18e-f8c9-4687-bf11-0a74c9f96a8f");
            public static readonly Guid SubType = new Guid("f7e34c9a-42e8-4714-b74b-cb29d72c35e5");
            public static readonly Guid FrameSize = new Guid("1652c33d-d6b2-4012-b834-72030849a37d");
            public static readonly Guid FrameRate = new Guid("c459a2e8-3d2c-4e44-b132-fee5156c7bb0");
            public static readonly Guid AvgBitrate = new Guid("20332624-fb0d-4d9e-bd0d-cbf6786c102e");
            public static readonly Guid InterlaceMode = new Guid("e2724bb8-e676-4806-b4b2-a8d6efb44ccd");
            public static readonly Guid PixelAspect = new Guid("c6376a1e-8d0a-4027-be45-6d9a0ad39bb6");
            public static readonly Guid Profile = new Guid("ad76a80b-2d5c-4e0b-b375-64e520137036");
            public static readonly Guid YuvMatrix = new Guid("3e23d450-2c75-4d25-a00e-b91670d12327");
            public static readonly Guid NominalRange = new Guid("c21b8ee5-b956-4071-8daf-325edf5cab11");
            public static readonly Guid Primaries = new Guid("dbfbe4d7-0740-4ee0-8192-850ab0e21935");
            public static readonly Guid TransferFunction = new Guid("5fb0fce9-be5c-4935-a811-ec838f8eed93");
            public static readonly Guid LowLatency = new Guid("9c27891a-ed7a-40e1-88e8-b22727a024ee");
            public static readonly Guid AsyncUnlock = new Guid("e5666d6b-3422-4eb6-a421-da7db1f8e207");
            public static readonly Guid CleanPoint = new Guid("9cdf01d8-a0f0-43ba-b077-eaa06cbd728a");
            public static readonly Guid IidTransform = new Guid("bf94c121-5b05-4e6f-8000-ba598961414d");
            public static readonly Guid IidEventGenerator = new Guid("2CD0BD52-BCD5-4B89-B62C-EADC0C031E7D");
            public static readonly Guid IidCodecApi = new Guid("901db4c7-31ce-41a2-85dc-8fa0bf41b8da");
            public static readonly Guid ApiRateControl = new Guid("1c0608e9-370c-4710-8a58-cb6181c42423");
            public static readonly Guid ApiMeanBitrate = new Guid("f7222374-2144-4815-b550-a37f8e12ee52");
            public static readonly Guid ApiGopSize = new Guid("95f31b26-95a4-41aa-9303-246a7fc6eef1");
            public static readonly Guid ApiBFrames = new Guid("8d390aac-dc5c-4200-b57f-814d04babab2");
            public static readonly Guid ApiLowLatency = new Guid("9c27891a-ed7a-40e1-88e8-b22727a024ee");
            public static readonly Guid ApiForceKey = new Guid("398c1b98-8353-475a-9ef2-8f265d260345");
            public static readonly Guid ApiQualityVsSpeed = new Guid("98332df8-03cd-476b-89fa-3f9e442dec9f");

            public const int E_NEED_MORE_INPUT = unchecked((int)0xC00D6D72);
            public const int E_STREAM_CHANGE = unchecked((int)0xC00D6D61);
            public const int E_NOTACCEPTING = unchecked((int)0xC00D36B5);
            public const int E_NO_EVENTS = unchecked((int)0xC00D3E80);
        }

        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int MfActivateObjectDel(IntPtr self, ref Guid iid, out IntPtr obj);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int MfSetUInt32Del(IntPtr self, ref Guid key, uint value);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int MfSetUInt64Del(IntPtr self, ref Guid key, ulong value);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int MfSetGuidDel(IntPtr self, ref Guid key, ref Guid value);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int MfGetUInt32Del(IntPtr self, ref Guid key, out uint value);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int MftGetAttributesDel(IntPtr self, out IntPtr attrs);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int MftSetTypeDel(IntPtr self, uint stream, IntPtr type, uint flags);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int MftGetAvailTypeDel(IntPtr self, uint stream, uint index, out IntPtr type);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int MftGetOutInfoDel(IntPtr self, uint stream, out MF.OutputStreamInfo info);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int MftProcessMessageDel(IntPtr self, uint msg, IntPtr param);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int MftProcessInputDel(IntPtr self, uint stream, IntPtr sample, uint flags);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int MftProcessOutputDel(IntPtr self, uint flags, uint count, ref MF.OutputDataBuffer buffers, out uint status);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int MfGetEventDel(IntPtr self, uint flags, out IntPtr evt);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int MfEventGetTypeDel(IntPtr self, out uint type);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int MfSampleSetTimeDel(IntPtr self, long time);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int MfSampleAddBufferDel(IntPtr self, IntPtr buffer);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int MfSampleToContiguousDel(IntPtr self, out IntPtr buffer);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int MfBufferLockDel(IntPtr self, out IntPtr data, out uint maxLen, out uint curLen);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int MfBufferUnlockDel(IntPtr self);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int MfBufferSetLengthDel(IntPtr self, uint len);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int CodecApiSetValueDel(IntPtr self, ref Guid api, IntPtr variant);

        private static int mfStarted = 0;
        private static bool videoDiag = false;

        private static void VDiag(string msg)
        {
            if (videoDiag) Console.Error.WriteLine("[video] " + msg);
        }

        // BridgeHelper.exe --video-selftest : prints encoder selection and per-frame timings
        // Encodes 30 synthetic frames; with a dump path every access unit is written as [u32 len][u8 key][bytes]
        private static void RunVideoSelfTest(bool av1, string dumpPath)
        {
            videoDiag = true;
            SN.CoInitializeEx(IntPtr.Zero, 0);
            int w = 1920, h = 1080;
            IntPtr nv12 = Marshal.AllocHGlobal(w * h * 3 / 2);
            var enc = new H264Encoder();
            var sw = Stopwatch.StartNew();
            bool ok = enc.Initialize(w, h, 60, 12000, av1);
            Console.Error.WriteLine("init ok=" + ok + " av1=" + enc.IsAv1 + " hw=" + enc.IsHardware + " ms=" + sw.ElapsedMilliseconds);
            if (!ok) return;
            FileStream dump = dumpPath != null ? File.Create(dumpPath) : null;
            for (int i = 0; i < 30; i++)
            {
                unsafe
                {
                    byte* p = (byte*)nv12;
                    for (int k = 0; k < w * h * 3 / 2; k++) p[k] = (byte)((k + i * 7) & 0xFF);
                }
                sw.Restart();
                bool key;
                byte[] au = enc.Encode(nv12, i == 0, out key);
                Console.Error.WriteLine("frame " + i + " bytes=" + (au == null ? -1 : au.Length) + " key=" + key + " ms=" + sw.ElapsedMilliseconds);
                if (dump != null && au != null)
                {
                    dump.Write(BitConverter.GetBytes(au.Length), 0, 4);
                    dump.WriteByte((byte)(key ? 1 : 0));
                    dump.Write(au, 0, au.Length);
                }
            }
            if (dump != null) dump.Dispose();
            enc.Dispose();
        }

        // BGRX (canvas) -> NV12, BT.709 limited range; chroma is the average of each 2x2 block
        private static unsafe void BgraToNv12(IntPtr src, int srcPitch, int w, int h, IntPtr dst)
        {
            IntPtr uvBase = dst + w * h;
            Parallel.For(0, h / 2, cy =>
            {
                int y0 = cy * 2;
                uint* r0 = (uint*)((byte*)src + (long)y0 * srcPitch);
                uint* r1 = (uint*)((byte*)src + (long)(y0 + 1) * srcPitch);
                byte* yl0 = (byte*)dst + (long)y0 * w;
                byte* yl1 = yl0 + w;
                byte* uv = (byte*)uvBase + (long)cy * w;
                for (int x = 0; x < w; x += 2)
                {
                    uint p00 = r0[x], p01 = r0[x + 1], p10 = r1[x], p11 = r1[x + 1];
                    int b00 = (int)(p00 & 0xFF), g00 = (int)((p00 >> 8) & 0xFF), q00 = (int)((p00 >> 16) & 0xFF);
                    int b01 = (int)(p01 & 0xFF), g01 = (int)((p01 >> 8) & 0xFF), q01 = (int)((p01 >> 16) & 0xFF);
                    int b10 = (int)(p10 & 0xFF), g10 = (int)((p10 >> 8) & 0xFF), q10 = (int)((p10 >> 16) & 0xFF);
                    int b11 = (int)(p11 & 0xFF), g11 = (int)((p11 >> 8) & 0xFF), q11 = (int)((p11 >> 16) & 0xFF);
                    yl0[x] = (byte)(((47 * q00 + 157 * g00 + 16 * b00 + 128) >> 8) + 16);
                    yl0[x + 1] = (byte)(((47 * q01 + 157 * g01 + 16 * b01 + 128) >> 8) + 16);
                    yl1[x] = (byte)(((47 * q10 + 157 * g10 + 16 * b10 + 128) >> 8) + 16);
                    yl1[x + 1] = (byte)(((47 * q11 + 157 * g11 + 16 * b11 + 128) >> 8) + 16);
                    int r = q00 + q01 + q10 + q11, g = g00 + g01 + g10 + g11, b = b00 + b01 + b10 + b11;
                    int u = ((-26 * r - 86 * g + 112 * b + 512) >> 10) + 128;
                    int v = ((112 * r - 102 * g - 10 * b + 512) >> 10) + 128;
                    uv[x] = (byte)(u < 0 ? 0 : (u > 255 ? 255 : u));
                    uv[x + 1] = (byte)(v < 0 ? 0 : (v > 255 ? 255 : v));
                }
            });
        }

        private sealed class H264Encoder : IDisposable
        {
            private IntPtr transform, events, codecApi;
            private bool isAsync, providesSamples;
            private uint outputSize;
            private int pendingNeedInput;
            private readonly List<byte[]> outputs = new List<byte[]>();
            private bool lastOutputKey;
            private readonly Stopwatch clock = Stopwatch.StartNew();
            private IntPtr variant = Marshal.AllocHGlobal(24);
            private readonly IntPtr[] inSamples = new IntPtr[2];
            private readonly IntPtr[] inBuffers = new IntPtr[2];
            private uint inBufferSize;
            private int inSlot;

            public int Width { get; private set; }
            public int Height { get; private set; }
            public int Fps { get; private set; }
            public int BitrateKbps { get; private set; }
            public bool IsHardware { get; private set; }
            public bool IsAv1 { get; private set; }
            public bool IsReady { get { return transform != IntPtr.Zero; } }

            // av1: hardware AV1 (e.g. NVENC on RTX 40, Intel Arc, Radeon RX 7000). There is no in-box software AV1
            // encoder, so AV1 only succeeds with a GPU encoder; the caller falls back to H.264.
            public bool Initialize(int w, int h, int fps, int kbps, bool av1 = false)
            {
                Dispose(false);
                if (Interlocked.Exchange(ref mfStarted, 1) == 0)
                {
                    try { MF.MFStartup(0x20070, 0); } catch { return false; }
                }
                // Hardware (async) first, then software (sync)
                bool softwareOnly = Environment.GetEnvironmentVariable("TAHABLT_VIDEO_SOFTWARE") == "1";
                foreach (uint flags in new uint[] { 0x04 | 0x40, 0x01 | 0x40 })
                {
                    if (softwareOnly && (flags & 0x04) != 0) continue;
                    if (av1 && (flags & 0x04) == 0) continue;
                    IntPtr arr;
                    uint count;
                    var input = new MF.RegisterTypeInfo { Major = MF.MediaTypeVideo, Sub = MF.FormatNV12 };
                    var output = new MF.RegisterTypeInfo { Major = MF.MediaTypeVideo, Sub = av1 ? MF.FormatAV1 : MF.FormatH264 };
                    int hrEnum = MF.MFTEnumEx(MF.CategoryVideoEncoder, flags, ref input, ref output, out arr, out count);
                    VDiag("MFTEnumEx flags=" + flags + " hr=" + hrEnum.ToString("X") + " count=" + count);
                    if (hrEnum != 0 || arr == IntPtr.Zero)
                        continue;
                    try
                    {
                        for (int i = 0; i < count && transform == IntPtr.Zero; i++)
                        {
                            IntPtr act = Marshal.ReadIntPtr(arr, i * IntPtr.Size);
                            if (TryCreate(act, (flags & 0x04) != 0, w, h, fps, kbps, av1)) break;
                            Dispose(false);
                        }
                    }
                    finally
                    {
                        for (int i = 0; i < count; i++)
                        {
                            IntPtr act = Marshal.ReadIntPtr(arr, i * IntPtr.Size);
                            if (act != IntPtr.Zero) Marshal.Release(act);
                        }
                        Marshal.FreeCoTaskMem(arr);
                    }
                    if (transform != IntPtr.Zero) return true;
                }
                return false;
            }

            private bool TryCreate(IntPtr activate, bool hardware, int w, int h, int fps, int kbps, bool av1)
            {
                IsAv1 = av1;
                Guid iid = MF.IidTransform;
                int hrAct = ComFn<MfActivateObjectDel>(activate, 33)(activate, ref iid, out transform);
                VDiag("ActivateObject hw=" + hardware + " hr=" + hrAct.ToString("X"));
                if (hrAct != 0 || transform == IntPtr.Zero)
                {
                    transform = IntPtr.Zero;
                    return false;
                }
                IsHardware = hardware;

                IntPtr attrs;
                if (ComFn<MftGetAttributesDel>(transform, 8)(transform, out attrs) == 0 && attrs != IntPtr.Zero)
                {
                    Guid k = MF.AsyncUnlock;
                    if (hardware) ComFn<MfSetUInt32Del>(attrs, 21)(attrs, ref k, 1);
                    k = MF.LowLatency;
                    ComFn<MfSetUInt32Del>(attrs, 21)(attrs, ref k, 1);
                    Marshal.Release(attrs);
                }
                Guid iidEv = MF.IidEventGenerator;
                IntPtr ev;
                if (hardware && Marshal.QueryInterface(transform, ref iidEv, out ev) == 0 && ev != IntPtr.Zero)
                {
                    events = ev;
                    isAsync = true;
                }
                Guid iidApi = MF.IidCodecApi;
                IntPtr api;
                if (Marshal.QueryInterface(transform, ref iidApi, out api) == 0) codecApi = api;

                Width = w;
                Height = h;
                Fps = fps;
                BitrateKbps = kbps;

                if (codecApi != IntPtr.Zero)
                {
                    SetApiUInt(MF.ApiRateControl, 0); // CBR: steady bitrate, predictable latency
                    SetApiUInt(MF.ApiMeanBitrate, (uint)kbps * 1000);
                    SetApiBool(MF.ApiLowLatency, true);
                    SetApiUInt(MF.ApiBFrames, 0);
                    SetApiUInt(MF.ApiGopSize, (uint)Math.Max(fps * 600, 1)); // IDR only on demand
                    SetApiUInt(MF.ApiQualityVsSpeed, 40);
                }

                bool outOk = false;
                // H.264: High, Main, Baseline. AV1: encoder default (Main 4:2:0 8-bit), then explicit Main
                foreach (uint profile in av1 ? new uint[] { uint.MaxValue, 0 } : new uint[] { 100, 77, 66 })
                {
                    IntPtr ot = CreateVideoType(av1 ? MF.FormatAV1 : MF.FormatH264, w, h, fps);
                    SetU32(ot, MF.AvgBitrate, (uint)kbps * 1000);
                    if (profile != uint.MaxValue) SetU32(ot, MF.Profile, profile);
                    int hr = ComFn<MftSetTypeDel>(transform, 16)(transform, 0, ot, 0);
                    VDiag("SetOutputType av1=" + av1 + " profile=" + profile + " hr=" + hr.ToString("X"));
                    Marshal.Release(ot);
                    if (hr == 0) { outOk = true; break; }
                }
                if (!outOk) return false;

                IntPtr it = CreateVideoType(MF.FormatNV12, w, h, fps);
                int hrIn = ComFn<MftSetTypeDel>(transform, 15)(transform, 0, it, 0);
                VDiag("SetInputType hr=" + hrIn.ToString("X") + " async=" + isAsync);
                Marshal.Release(it);
                if (hrIn != 0) return false;

                MF.OutputStreamInfo info;
                if (ComFn<MftGetOutInfoDel>(transform, 7)(transform, 0, out info) != 0) return false;
                providesSamples = (info.Flags & 0x100) != 0;
                outputSize = Math.Max(info.Size, (uint)(w * h * 3 / 2 + 65536));

                var msg = ComFn<MftProcessMessageDel>(transform, 23);
                msg(transform, 0x10000000, IntPtr.Zero); // NOTIFY_BEGIN_STREAMING
                msg(transform, 0x10000003, IntPtr.Zero); // NOTIFY_START_OF_STREAM
                pendingNeedInput = 0;
                return true;
            }

            private static IntPtr CreateVideoType(Guid subtype, int w, int h, int fps)
            {
                IntPtr t;
                MF.MFCreateMediaType(out t);
                Guid k = MF.MajorType, v = MF.MediaTypeVideo;
                ComFn<MfSetGuidDel>(t, 24)(t, ref k, ref v);
                k = MF.SubType; v = subtype;
                ComFn<MfSetGuidDel>(t, 24)(t, ref k, ref v);
                SetU64(t, MF.FrameSize, ((ulong)(uint)w << 32) | (uint)h);
                SetU64(t, MF.FrameRate, ((ulong)(uint)fps << 32) | 1u);
                SetU64(t, MF.PixelAspect, (1UL << 32) | 1u);
                SetU32(t, MF.InterlaceMode, 2); // progressive
                SetU32(t, MF.YuvMatrix, 1);     // BT.709
                SetU32(t, MF.NominalRange, 2);  // 16-235
                SetU32(t, MF.Primaries, 2);     // BT.709
                SetU32(t, MF.TransferFunction, 5); // BT.709
                return t;
            }

            private static void SetU32(IntPtr attrs, Guid key, uint value)
            {
                ComFn<MfSetUInt32Del>(attrs, 21)(attrs, ref key, value);
            }

            private static void SetU64(IntPtr attrs, Guid key, ulong value)
            {
                ComFn<MfSetUInt64Del>(attrs, 22)(attrs, ref key, value);
            }

            private unsafe void SetApiUInt(Guid api, uint value)
            {
                if (codecApi == IntPtr.Zero) return;
                byte* p = (byte*)variant;
                for (int i = 0; i < 24; i++) p[i] = 0;
                *(ushort*)p = 19; // VT_UI4
                *(uint*)(p + 8) = value;
                try { ComFn<CodecApiSetValueDel>(codecApi, 9)(codecApi, ref api, variant); } catch { }
            }

            private unsafe void SetApiBool(Guid api, bool value)
            {
                if (codecApi == IntPtr.Zero) return;
                byte* p = (byte*)variant;
                for (int i = 0; i < 24; i++) p[i] = 0;
                *(ushort*)p = 11; // VT_BOOL
                *(short*)(p + 8) = (short)(value ? -1 : 0);
                try { ComFn<CodecApiSetValueDel>(codecApi, 9)(codecApi, ref api, variant); } catch { }
            }

            public void SetBitrate(int kbps)
            {
                if (kbps == BitrateKbps || transform == IntPtr.Zero) return;
                BitrateKbps = kbps;
                SetApiUInt(MF.ApiMeanBitrate, (uint)kbps * 1000);
            }

            private bool EnsureInputPool(uint size)
            {
                if (inBufferSize == size && inSamples[0] != IntPtr.Zero && inSamples[1] != IntPtr.Zero) return true;
                for (int i = 0; i < 2; i++)
                {
                    ComRelease(ref inSamples[i]);
                    ComRelease(ref inBuffers[i]);
                }
                inBufferSize = 0;
                for (int i = 0; i < 2; i++)
                {
                    if (MF.MFCreateMemoryBuffer(size, out inBuffers[i]) != 0 || inBuffers[i] == IntPtr.Zero) return false;
                    if (MF.MFCreateSample(out inSamples[i]) != 0 || inSamples[i] == IntPtr.Zero) return false;
                    ComFn<MfSampleAddBufferDel>(inSamples[i], 42)(inSamples[i], inBuffers[i]);
                }
                inBufferSize = size;
                return true;
            }

            // Encodes one NV12 frame. Returns the Annex B access unit or null on failure.
            public byte[] Encode(IntPtr nv12, bool forceKey, out bool isKey)
            {
                isKey = false;
                if (transform == IntPtr.Zero) return null;
                outputs.Clear();
                lastOutputKey = false;
                int size = Width * Height * 3 / 2;

                if (!EnsureInputPool((uint)size)) return null;
                int slot = inSlot;
                inSlot = (inSlot + 1) & 1;
                IntPtr buffer = inBuffers[slot];
                IntPtr sample = inSamples[slot];

                IntPtr data;
                uint maxLen, curLen;
                if (ComFn<MfBufferLockDel>(buffer, 3)(buffer, out data, out maxLen, out curLen) != 0) return null;
                unsafe { Buffer.MemoryCopy((void*)nv12, (void*)data, maxLen, size); }
                ComFn<MfBufferUnlockDel>(buffer, 4)(buffer);
                ComFn<MfBufferSetLengthDel>(buffer, 6)(buffer, (uint)size);
                long ts = clock.ElapsedTicks * 10000000L / Stopwatch.Frequency;
                ComFn<MfSampleSetTimeDel>(sample, 36)(sample, ts);
                ComFn<MfSampleSetTimeDel>(sample, 38)(sample, 10000000L / Math.Max(1, Fps));

                if (forceKey) SetApiUInt(MF.ApiForceKey, 1);

                bool ok = isAsync ? EncodeAsync(sample) : EncodeSync(sample);
                if (!ok) return null;

                if (outputs.Count == 0) return null;
                isKey = lastOutputKey;
                if (outputs.Count == 1) return outputs[0];
                using (var ms = new MemoryStream())
                {
                    foreach (var o in outputs) ms.Write(o, 0, o.Length);
                    return ms.ToArray();
                }
            }

            private bool EncodeSync(IntPtr sample)
            {
                var processInput = ComFn<MftProcessInputDel>(transform, 24);
                int hr = processInput(transform, 0, sample, 0);
                if (hr == MF.E_NOTACCEPTING)
                {
                    DrainOutput();
                    hr = processInput(transform, 0, sample, 0);
                }
                if (hr != 0) { VDiag("sync ProcessInput hr=" + hr.ToString("X")); return false; }
                DrainOutput();
                return true;
            }

            private bool EncodeAsync(IntPtr sample)
            {
                var sw = Stopwatch.StartNew();
                // Wait for the encoder to ask for input
                while (pendingNeedInput == 0)
                {
                    if (!PumpEvents()) return false;
                    if (pendingNeedInput > 0) break;
                    if (sw.ElapsedMilliseconds > 250) { VDiag("no NeedInput event"); return false; }
                    WaitBriefly(sw);
                }
                int hrPi = ComFn<MftProcessInputDel>(transform, 24)(transform, 0, sample, 0);
                if (hrPi != 0) { VDiag("async ProcessInput hr=" + hrPi.ToString("X")); return false; }
                pendingNeedInput--;
                // Low-latency hardware encoders emit the access unit for this input within a few ms
                sw.Restart();
                while (outputs.Count == 0 && sw.ElapsedMilliseconds < 250)
                {
                    if (!PumpEvents()) return false;
                    if (outputs.Count > 0) break;
                    WaitBriefly(sw);
                }
                return outputs.Count > 0;
            }

            // Hardware encoders answer within a few ms: spin first, then yield the core
            private static void WaitBriefly(Stopwatch sw)
            {
                if (sw.ElapsedTicks < Stopwatch.Frequency / 250) Thread.SpinWait(200);
                else if (sw.ElapsedMilliseconds < 20) Thread.Sleep(0);
                else Thread.Sleep(1);
            }

            private bool PumpEvents()
            {
                var getEvent = ComFn<MfGetEventDel>(events, 3);
                while (true)
                {
                    IntPtr evt;
                    int hr = getEvent(events, 1 /* NO_WAIT */, out evt);
                    if (hr == MF.E_NO_EVENTS) return true;
                    if (hr != 0 || evt == IntPtr.Zero) { VDiag("GetEvent hr=" + hr.ToString("X")); return false; }
                    uint type;
                    ComFn<MfEventGetTypeDel>(evt, 33)(evt, out type);
                    Marshal.Release(evt);
                    if (type == 601) pendingNeedInput++;
                    else if (type == 602) DrainOutput();
                }
            }

            private void DrainOutput()
            {
                var processOutput = ComFn<MftProcessOutputDel>(transform, 25);
                for (int guard = 0; guard < 8; guard++)
                {
                    IntPtr outSample = IntPtr.Zero, outBuffer = IntPtr.Zero;
                    if (!providesSamples)
                    {
                        MF.MFCreateSample(out outSample);
                        MF.MFCreateMemoryBuffer(outputSize, out outBuffer);
                        ComFn<MfSampleAddBufferDel>(outSample, 42)(outSample, outBuffer);
                    }
                    var odb = new MF.OutputDataBuffer { StreamId = 0, Sample = outSample };
                    uint status;
                    int hr = processOutput(transform, 0, 1, ref odb, out status);
                    if (odb.Events != IntPtr.Zero) Marshal.Release(odb.Events);
                    try
                    {
                        if (hr == MF.E_NEED_MORE_INPUT) return;
                        if (hr == MF.E_STREAM_CHANGE)
                        {
                            IntPtr t;
                            if (ComFn<MftGetAvailTypeDel>(transform, 14)(transform, 0, 0, out t) == 0)
                            {
                                ComFn<MftSetTypeDel>(transform, 16)(transform, 0, t, 0);
                                Marshal.Release(t);
                            }
                            continue;
                        }
                        if (hr != 0 || odb.Sample == IntPtr.Zero) { VDiag("ProcessOutput hr=" + hr.ToString("X")); return; }

                        IntPtr contiguous;
                        if (ComFn<MfSampleToContiguousDel>(odb.Sample, 41)(odb.Sample, out contiguous) == 0)
                        {
                            IntPtr data;
                            uint maxLen, curLen;
                            if (ComFn<MfBufferLockDel>(contiguous, 3)(contiguous, out data, out maxLen, out curLen) == 0)
                            {
                                byte[] bytes = new byte[curLen];
                                Marshal.Copy(data, bytes, 0, (int)curLen);
                                ComFn<MfBufferUnlockDel>(contiguous, 4)(contiguous);
                                if (curLen > 0) outputs.Add(bytes);
                            }
                            Marshal.Release(contiguous);
                        }
                        Guid cp = MF.CleanPoint;
                        uint clean;
                        if (ComFn<MfGetUInt32Del>(odb.Sample, 7)(odb.Sample, ref cp, out clean) == 0 && clean != 0) lastOutputKey = true;
                    }
                    finally
                    {
                        if (odb.Sample != IntPtr.Zero && odb.Sample != outSample) Marshal.Release(odb.Sample);
                        if (outSample != IntPtr.Zero) Marshal.Release(outSample);
                        if (outBuffer != IntPtr.Zero) Marshal.Release(outBuffer);
                    }
                    if (isAsync) return; // one output per HaveOutput event
                }
            }

            private void Dispose(bool freeVariant)
            {
                if (transform != IntPtr.Zero)
                {
                    try { ComFn<MftProcessMessageDel>(transform, 23)(transform, 0x10000001 /* END_STREAMING */, IntPtr.Zero); } catch { }
                }
                for (int i = 0; i < 2; i++)
                {
                    ComRelease(ref inSamples[i]);
                    ComRelease(ref inBuffers[i]);
                }
                inBufferSize = 0;
                ComRelease(ref events);
                ComRelease(ref codecApi);
                ComRelease(ref transform);
                isAsync = false;
                pendingNeedInput = 0;
                if (freeVariant && variant != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(variant);
                    variant = IntPtr.Zero;
                }
            }

            public void Dispose()
            {
                Dispose(true);
            }
        }
    }
}
