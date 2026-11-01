using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.ServiceProcess;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace TahaBLTTray
{
    public class TrayApp : ApplicationContext
    {
        private NotifyIcon trayIcon;
        private ContextMenu nativeMenu;
        private MenuItem connectActionItem;
        private MenuItem connectedDevicesMenu;
        private MenuItem subConfigsMenu;
        private MenuItem lanItem;
        private MenuItem startupItem;
        private Process nodeProcess;
        private System.Windows.Forms.Timer refreshTimer;
        private System.Windows.Forms.Timer reopenMenuTimer;
        private bool isExiting = false;
        private bool startupToastShown = false;
        private bool isProgrammaticReopen = false;
        private Point lastMenuOpenPoint = Point.Empty;
        private string lastDevicesSignature = "";

        private string baseDir;
        private string agentDir;
        private string currentPin = "";
        private long currentPinExpiresAt = 0;
        private string currentLanIp = "127.0.0.1";
        private int currentPort = 4850;
        private int connectedClients = 0;

        private const string RUN_KEY = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string APP_REG_NAME = "Bridge";
        private const string OLD_APP_REG_NAME = "TahaBLTConnect"; // name before the rebrand, cleaned up on start
        private const string SERVICE_NAME = Program.SERVICE_NAME;

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern bool DestroyIcon(IntPtr handle);

        [DllImport("user32.dll", ExactSpelling = true, CharSet = CharSet.Auto)]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll", ExactSpelling = true, CharSet = CharSet.Auto)]
        private static extern bool TrackPopupMenuEx(IntPtr hmenu, int fuFlags, int x, int y, IntPtr hwnd, IntPtr tpm);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern bool PostMessage(IntPtr hwnd, int msg, IntPtr wparam, IntPtr lparam);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern uint RegisterWindowMessage(string lpString);

        private sealed class TaskbarCreatedWatcher : NativeWindow
        {
            private readonly Action onTaskbarCreated;
            private readonly uint wmTaskbarCreated;

            public TaskbarCreatedWatcher(Action callback)
            {
                onTaskbarCreated = callback;
                wmTaskbarCreated = RegisterWindowMessage("TaskbarCreated");
                CreateHandle(new CreateParams());
            }

            protected override void WndProc(ref Message m)
            {
                if (wmTaskbarCreated != 0 && (uint)m.Msg == wmTaskbarCreated)
                {
                    try { if (onTaskbarCreated != null) onTaskbarCreated(); } catch { }
                }
                base.WndProc(ref m);
            }
        }

        private TaskbarCreatedWatcher taskbarWatcher;
        private int promoteTickCount = 0;

        public TrayApp()
        {
            baseDir = AppDomain.CurrentDomain.BaseDirectory;
            agentDir = Path.Combine(baseDir, "pc-agent");
            if (!Directory.Exists(agentDir))
            {
                if (File.Exists(Path.Combine(baseDir, "server.js")))
                    agentDir = baseDir;
                else if (File.Exists(Path.Combine(baseDir, "..", "server.js")))
                    agentDir = Path.GetFullPath(Path.Combine(baseDir, ".."));
            }

            // Ensure auto-start on login is registered by default
            if (!IsStartupEnabled())
            {
                SetStartupEnabled(true);
            }

            BuildWindows11NativeMenu();

            trayIcon = new NotifyIcon
            {
                Icon = CreateMinimalMonochromeTrayIcon(),
                Text = "Bridge",
                ContextMenu = nativeMenu,
                Visible = true
            };

            EnsureTrayIconPromoted();

            taskbarWatcher = new TaskbarCreatedWatcher(() =>
            {
                try
                {
                    trayIcon.Visible = false;
                    trayIcon.Icon = CreateMinimalMonochromeTrayIcon();
                    trayIcon.Visible = true;
                    EnsureTrayIconPromoted();
                }
                catch { }
            });

            trayIcon.DoubleClick += (s, e) => CopyPairingSummary();
            trayIcon.MouseClick += (s, e) =>
            {
                if (e.Button == MouseButtons.Left)
                {
                    CopyPairingSummary();
                }
            };

            StartNodeAgent();

            reopenMenuTimer = new System.Windows.Forms.Timer { Interval = 10 };
            reopenMenuTimer.Tick += (s, e) =>
            {
                reopenMenuTimer.Stop();
                ReopenMenuAtSavedPosition();
            };

            refreshTimer = new System.Windows.Forms.Timer { Interval = 1000 };
            refreshTimer.Tick += (s, e) =>
            {
                if (promoteTickCount < 5)
                {
                    promoteTickCount++;
                    EnsureTrayIconPromoted();
                }
                RefreshStatus(false);
            };
            refreshTimer.Start();

            RefreshStatus(true);
        }

        private static void EnsureTrayIconPromoted()
        {
            try
            {
                using (RegistryKey settingsKey = Registry.CurrentUser.OpenSubKey(@"Control Panel\NotifyIconSettings", true))
                {
                    if (settingsKey == null) return;
                    foreach (string subName in settingsKey.GetSubKeyNames())
                    {
                        try
                        {
                            using (RegistryKey sub = settingsKey.OpenSubKey(subName, true))
                            {
                                if (sub == null) continue;
                                string exePath = Convert.ToString(sub.GetValue("ExecutablePath") ?? "");
                                if (exePath.EndsWith(@"\Bridge.exe", StringComparison.OrdinalIgnoreCase) ||
                                    exePath.IndexOf("Bridge.exe", StringComparison.OrdinalIgnoreCase) >= 0)
                                {
                                    object cur = sub.GetValue("IsPromoted");
                                    if (cur == null || Convert.ToInt32(cur) != 1)
                                    {
                                        sub.SetValue("IsPromoted", 1, RegistryValueKind.DWord);
                                    }
                                }
                            }
                        }
                        catch { }
                    }
                }
            }
            catch { }
        }

        // Tray icon: the transparent Bridge logo from app.ico at the tray's size (falls back to the exe's own icon,
        // which embeds the same .ico)
        public static Icon CreateMinimalMonochromeTrayIcon()
        {
            try
            {
                string exeDir = Path.GetDirectoryName(Application.ExecutablePath) ?? "";
                string ico = Path.Combine(exeDir, "pc-agent", "native", "app.ico");
                if (File.Exists(ico)) return new Icon(ico, SystemInformation.SmallIconSize);
            }
            catch { }
            try
            {
                Icon own = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (own != null) return own;
            }
            catch { }
            return SystemIcons.Application;
        }

        private void BuildWindows11NativeMenu()
        {
            nativeMenu = new ContextMenu();
            nativeMenu.Popup += (s, e) =>
            {
                if (!isProgrammaticReopen)
                {
                    lastMenuOpenPoint = Cursor.Position;
                }
                isProgrammaticReopen = false;
                RefreshStatus(true);
            };

            connectActionItem = new MenuItem("Bağlantı Kur (30 sn Kod Oluştur)");
            connectActionItem.Click += (s, e) => StartThirtySecondPairingSession(true);

            connectedDevicesMenu = new MenuItem("Bağlı Cihazlar (0)");
            MenuItem emptyDevicePlaceholder = new MenuItem("Eşleşmiş cihaz yok") { Enabled = false };
            connectedDevicesMenu.MenuItems.Add(emptyDevicePlaceholder);

            subConfigsMenu = new MenuItem("Bağlantı ve Ayarlar");

            lanItem = new MenuItem("Yerel Ağ: " + currentLanIp + ":" + currentPort);
            lanItem.Click += (s, e) =>
            {
                try { Clipboard.SetText(currentLanIp + ":" + currentPort); } catch { }
            };

            startupItem = new MenuItem("Başlangıçta Otomatik Çalıştır")
            {
                Checked = IsStartupEnabled()
            };
            startupItem.Click += (s, e) =>
            {
                bool next = !IsStartupEnabled();
                SetStartupEnabled(next);
                startupItem.Checked = next;
            };

            MenuItem sysServiceItem = new MenuItem("Wake-on-LAN ve Kilit Ekranı Servisi")
            {
                Checked = Program.IsSystemServiceInstalledAndRunning() && Program.IsNicWakeOnLanConfigured()
            };
            sysServiceItem.Click += (s, e) =>
            {
                try
                {
                    Process p = Process.Start(new ProcessStartInfo
                    {
                        FileName = Application.ExecutablePath,
                        Arguments = "--setup-system",
                        Verb = "runas",
                        UseShellExecute = true,
                        WindowStyle = ProcessWindowStyle.Hidden
                    });
                    if (p != null) p.WaitForExit(12000);
                    sysServiceItem.Checked = Program.IsSystemServiceInstalledAndRunning() && Program.IsNicWakeOnLanConfigured();
                    trayIcon.ShowBalloonTip(
                        2600,
                        "Bridge — Sistem Servisi Aktif",
                        "Wake-on-LAN ağ kartı ayarları ve giriş öncesi Kilit Ekranı (Winlogon) servisi etkinleştirildi.",
                        ToolTipIcon.None
                    );
                }
                catch { }
            };

            MenuItem restartItem = new MenuItem("Servisi Yeniden Başlat");
            restartItem.Click += (s, e) =>
            {
                TriggerLocalApi("/api/takeover");
                StopNodeAgent();
                ThreadPool.QueueUserWorkItem(_ =>
                {
                    Thread.Sleep(600);
                    StartNodeAgent();
                });
            };

            MenuItem checkUpdateItem = new MenuItem("Güncellemeleri Denetle");
            checkUpdateItem.Click += (s, e) => CheckForUpdatesFromTray();

            subConfigsMenu.MenuItems.Add(lanItem);
            subConfigsMenu.MenuItems.Add(new MenuItem("-"));
            subConfigsMenu.MenuItems.Add(startupItem);
            subConfigsMenu.MenuItems.Add(sysServiceItem);
            subConfigsMenu.MenuItems.Add(checkUpdateItem);
            subConfigsMenu.MenuItems.Add(restartItem);

            MenuItem exitItem = new MenuItem("Exit");
            exitItem.Click += (s, e) => ExitApplication();

            nativeMenu.MenuItems.Add(connectActionItem);
            nativeMenu.MenuItems.Add(connectedDevicesMenu);
            nativeMenu.MenuItems.Add(new MenuItem("-"));
            nativeMenu.MenuItems.Add(subConfigsMenu);
            nativeMenu.MenuItems.Add(new MenuItem("-"));
            nativeMenu.MenuItems.Add(exitItem);
        }

        private void ReopenMenuAtSavedPosition()
        {
            try
            {
                Point pt = lastMenuOpenPoint;
                if (pt == Point.Empty)
                {
                    pt = Cursor.Position;
                }

                FieldInfo windowField = typeof(NotifyIcon).GetField("window", BindingFlags.Instance | BindingFlags.NonPublic);
                NativeWindow notifyWindow = windowField != null ? (NativeWindow)windowField.GetValue(trayIcon) : null;
                if (notifyWindow != null && notifyWindow.Handle != IntPtr.Zero)
                {
                    isProgrammaticReopen = true;
                    MethodInfo onPopupMethod = typeof(ContextMenu).GetMethod("OnPopup", BindingFlags.Instance | BindingFlags.NonPublic);
                    if (onPopupMethod != null)
                    {
                        onPopupMethod.Invoke(nativeMenu, new object[] { EventArgs.Empty });
                    }
                    SetForegroundWindow(notifyWindow.Handle);
                    TrackPopupMenuEx(nativeMenu.Handle, 72, pt.X, pt.Y, notifyWindow.Handle, IntPtr.Zero);
                    PostMessage(notifyWindow.Handle, 0, IntPtr.Zero, IntPtr.Zero);
                }
            }
            catch
            {
                isProgrammaticReopen = false;
            }
        }

        private int GetRemainingPinSeconds()
        {
            if (string.IsNullOrEmpty(currentPin) || currentPin == "----" || currentPinExpiresAt <= 0) return 0;
            long nowMs = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
            long diffMs = currentPinExpiresAt - nowMs;
            if (diffMs <= 0) return 0;
            return (int)Math.Ceiling(diffMs / 1000.0);
        }

        private void StartThirtySecondPairingSession(bool keepMenuOpen = false)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + currentPort + "/api/pair/rotate");
                req.Method = "POST";
                req.Headers["X-TahaBLT-Admin"] = ReadAdminKey();
                req.Timeout = 1500;
                req.ContentLength = 0;
                using (var resp = req.GetResponse())
                using (var reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    string body = reader.ReadToEnd();
                    var serializer = new JavaScriptSerializer();
                    var parsed = serializer.Deserialize<Dictionary<string, object>>(body);
                    if (parsed != null)
                    {
                        if (parsed.ContainsKey("pin")) currentPin = Convert.ToString(parsed["pin"]);
                        if (parsed.ContainsKey("pinExpiresAt")) currentPinExpiresAt = Convert.ToInt64(parsed["pinExpiresAt"]);
                    }
                }
            }
            catch { }

            try
            {
                RefreshStatus(false);
                if (!string.IsNullOrEmpty(currentPin))
                {
                    try { Clipboard.SetText(currentPin); } catch { }
                    if (connectActionItem != null)
                    {
                        int remSec = GetRemainingPinSeconds();
                        if (remSec <= 0) remSec = 30;
                        connectActionItem.Text = string.Format("Bağlantı Kur: {0} ({1} sn - Kopyalandı)", currentPin, remSec);
                    }
                }
            }
            catch { }

            if (keepMenuOpen && reopenMenuTimer != null)
            {
                reopenMenuTimer.Stop();
                reopenMenuTimer.Start();
            }
        }

        private void CopyPairingSummary()
        {
            try
            {
                if (GetRemainingPinSeconds() <= 0 || string.IsNullOrEmpty(currentPin))
                {
                    StartThirtySecondPairingSession(false);
                    return;
                }
                Clipboard.SetText(currentPin);
            }
            catch { }
        }

        private bool IsAgentPortListening()
        {
            try
            {
                using (var tcp = new System.Net.Sockets.TcpClient())
                {
                    var ar = tcp.BeginConnect("127.0.0.1", currentPort, null, null);
                    bool ok = ar.AsyncWaitHandle.WaitOne(250);
                    if (ok && tcp.Connected) return true;
                }
            }
            catch { }
            return false;
        }

        private void StartNodeAgent()
        {
            try
            {
                if (nodeProcess != null && !nodeProcess.HasExited) return;
                // If the Bridge service is already running server.js in our console session as SYSTEM, attach to it!
                if (IsAgentPortListening()) return;

                string serverScript = Path.Combine(agentDir, "server.js");
                if (!File.Exists(serverScript)) return;

                string nodeExe = "node.exe";
                string bundledNode1 = Path.Combine(agentDir, "native", "node.exe");
                string bundledNode2 = Path.Combine(baseDir, "node.exe");
                string progFilesNode = @"C:\Program Files\nodejs\node.exe";
                if (File.Exists(bundledNode1)) nodeExe = bundledNode1;
                else if (File.Exists(bundledNode2)) nodeExe = bundledNode2;
                else if (File.Exists(progFilesNode)) nodeExe = progFilesNode;

                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = nodeExe,
                    Arguments = "\"" + serverScript + "\" --parent-pid " + Process.GetCurrentProcess().Id,
                    WorkingDirectory = agentDir,
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden
                };

                nodeProcess = Process.Start(psi);
            }
            catch { }
        }

        private void StopNodeAgent()
        {
            try
            {
                if (nodeProcess != null && !nodeProcess.HasExited)
                {
                    nodeProcess.Kill();
                    nodeProcess.WaitForExit(1500);
                }
            }
            catch { }
            nodeProcess = null;
        }

        private string FormatIsoTimestamp(string iso)
        {
            if (string.IsNullOrEmpty(iso)) return "-";
            try
            {
                DateTime dt = DateTime.Parse(iso, null, System.Globalization.DateTimeStyles.RoundtripKind).ToLocalTime();
                return dt.ToString("dd.MM.yyyy HH:mm:ss");
            }
            catch
            {
                return iso;
            }
        }

        private void RebuildConnectedDevicesSubmenu(System.Collections.ArrayList rawDevices, bool forceRebuild)
        {
            if (connectedDevicesMenu == null) return;

            int count = rawDevices != null ? rawDevices.Count : 0;
            int headerCount = count;
            connectedDevicesMenu.Text = string.Format("Bağlı Cihazlar ({0})", headerCount);

            StringBuilder sigBuilder = new StringBuilder();
            sigBuilder.Append(headerCount).Append("|");
            if (rawDevices != null)
            {
                foreach (object itemObj in rawDevices)
                {
                    var d = itemObj as Dictionary<string, object>;
                    if (d == null) continue;
                    string id = d.ContainsKey("id") ? Convert.ToString(d["id"]) : "";
                    string name = d.ContainsKey("name") ? Convert.ToString(d["name"]) : "";
                    string ip = d.ContainsKey("ip") ? Convert.ToString(d["ip"]) : "";
                    string route = d.ContainsKey("route") ? Convert.ToString(d["route"]) : "";
                    bool online = d.ContainsKey("online") && Convert.ToBoolean(d["online"]);
                    sigBuilder.Append(id).Append(":").Append(name).Append(":").Append(ip).Append(":").Append(route).Append(":").Append(online).Append(";");
                }
            }

            string newSig = sigBuilder.ToString();
            if (!forceRebuild && newSig == lastDevicesSignature)
            {
                return;
            }
            lastDevicesSignature = newSig;

            connectedDevicesMenu.MenuItems.Clear();

            if (rawDevices == null || rawDevices.Count == 0)
            {
                MenuItem emptyItem = new MenuItem("Eşleşmiş cihaz yok") { Enabled = false };
                connectedDevicesMenu.MenuItems.Add(emptyItem);
                return;
            }

            foreach (object itemObj in rawDevices)
            {
                var d = itemObj as Dictionary<string, object>;
                if (d == null) continue;

                string devId = d.ContainsKey("id") ? Convert.ToString(d["id"]) : "";
                string devName = d.ContainsKey("name") ? Convert.ToString(d["name"]) : "Mobil Cihaz";
                string devIp = d.ContainsKey("ip") ? Convert.ToString(d["ip"]) : "Bilinmiyor";
                string devRoute = d.ContainsKey("route") ? Convert.ToString(d["route"]) : "Yerel Ağ";
                bool isOnline = d.ContainsKey("online") && Convert.ToBoolean(d["online"]);
                string lastSeenAt = d.ContainsKey("lastSeenAt") ? Convert.ToString(d["lastSeenAt"]) : "";
                string pairedAt = d.ContainsKey("pairedAt") ? Convert.ToString(d["pairedAt"]) : "";

                string statusBadge = isOnline ? "Aktif" : "Eşleşmiş";
                MenuItem deviceSubMenu = new MenuItem(string.Format("{0} ({1})", devName, statusBadge));

                MenuItem statusInfoItem = new MenuItem(string.Format("Durum: {0} ({1})", isOnline ? "Şu An Aktif" : "Eşleşmiş · Bağlanabilir", devRoute))
                {
                    Enabled = false
                };
                MenuItem ipInfoItem = new MenuItem("IP Adresi: " + devIp)
                {
                    Enabled = false
                };
                MenuItem lastSeenInfoItem = new MenuItem("Son Bağlantı: " + FormatIsoTimestamp(lastSeenAt))
                {
                    Enabled = false
                };
                MenuItem pairedAtInfoItem = new MenuItem("İlk Eşleşme: " + FormatIsoTimestamp(pairedAt))
                {
                    Enabled = false
                };

                string capturedId = devId;
                string capturedName = devName;
                MenuItem disconnectThisItem = new MenuItem("Bağlantıyı Kes");
                disconnectThisItem.Click += (s, e) =>
                {
                    TriggerLocalApi("/api/sessions/disconnect-device?id=" + Uri.EscapeDataString(capturedId));
                    ThreadPool.QueueUserWorkItem(_ =>
                    {
                        Thread.Sleep(250);
                        try
                        {
                            RefreshStatus(true);
                            trayIcon.ShowBalloonTip(
                                2500,
                                "Bridge — Bağlantı Kesildi",
                                capturedName + " cihazının bağlantısı kesildi ve oturum kodu geçersiz kılındı.",
                                ToolTipIcon.None
                            );
                        }
                        catch { }
                    });
                };

                deviceSubMenu.MenuItems.Add(statusInfoItem);
                deviceSubMenu.MenuItems.Add(ipInfoItem);
                deviceSubMenu.MenuItems.Add(lastSeenInfoItem);
                deviceSubMenu.MenuItems.Add(pairedAtInfoItem);
                deviceSubMenu.MenuItems.Add(new MenuItem("-"));
                deviceSubMenu.MenuItems.Add(disconnectThisItem);

                connectedDevicesMenu.MenuItems.Add(deviceSubMenu);
            }

            if (rawDevices.Count > 1)
            {
                connectedDevicesMenu.MenuItems.Add(new MenuItem("-"));
                MenuItem disconnectAllItem = new MenuItem("Tüm Cihazların Bağlantısını Kes");
                disconnectAllItem.Click += (s, e) =>
                {
                    TriggerLocalApi("/api/sessions/disconnect");
                    ThreadPool.QueueUserWorkItem(_ =>
                    {
                        Thread.Sleep(250);
                        try
                        {
                            RefreshStatus(true);
                            trayIcon.ShowBalloonTip(
                                2500,
                                "Bridge — Tüm Bağlantılar Kesildi",
                                "Tüm bağlı cihazların oturumları sonlandırıldı.",
                                ToolTipIcon.None
                            );
                        }
                        catch { }
                    });
                };
                connectedDevicesMenu.MenuItems.Add(disconnectAllItem);
            }
        }

        private void RefreshStatus(bool forceMenuRebuild = false)
        {
            if (isExiting) return;

            if (nodeProcess == null || nodeProcess.HasExited)
            {
                StartNodeAgent();
            }

            try
            {
                string stateFile = DataFilePath("runtime-status.json");
                if (File.Exists(stateFile))
                {
                    string json = File.ReadAllText(stateFile, Encoding.UTF8);
                    var serializer = new JavaScriptSerializer();
                    var data = serializer.Deserialize<Dictionary<string, object>>(json);

                    if (data.ContainsKey("pin")) currentPin = Convert.ToString(data["pin"]);
                    if (data.ContainsKey("pinExpiresAt")) currentPinExpiresAt = Convert.ToInt64(data["pinExpiresAt"]);
                    if (data.ContainsKey("lanIp")) currentLanIp = Convert.ToString(data["lanIp"]);
                    if (data.ContainsKey("port")) currentPort = Convert.ToInt32(data["port"]);
                    if (data.ContainsKey("connectedClients")) connectedClients = Convert.ToInt32(data["connectedClients"]);

                    System.Collections.ArrayList rawDevices = null;
                    if (data.ContainsKey("devices") && data["devices"] is System.Collections.ArrayList)
                    {
                        rawDevices = (System.Collections.ArrayList)data["devices"];
                    }

                    int remSec = GetRemainingPinSeconds();
                    if (remSec > 0 && !string.IsNullOrEmpty(currentPin))
                    {
                        if (connectActionItem != null)
                        {
                            connectActionItem.Text = string.Format("Bağlantı Kur: {0} ({1} sn - Kopyalandı)", currentPin, remSec);
                        }
                    }
                    else
                    {
                        currentPin = "";
                        if (connectActionItem != null)
                        {
                            connectActionItem.Text = "Bağlantı Kur (30 sn Kod Oluştur)";
                        }
                    }

                    RebuildConnectedDevicesSubmenu(rawDevices, forceMenuRebuild);
                    lanItem.Text = string.Format("Yerel Ağ: " + currentLanIp + ":" + currentPort);

                    string tip = remSec > 0
                        ? string.Format("Bridge — Kod: {0} ({1} sn)", currentPin, remSec)
                        : string.Format("Bridge ({0})", connectedClients > 0 ? (connectedClients + " Bağlı") : currentLanIp);
                    if (tip.Length > 63) tip = tip.Substring(0, 63);
                    trayIcon.Text = tip;

                    if (!startupToastShown)
                    {
                        startupToastShown = true;
                        trayIcon.ShowBalloonTip(
                            2600,
                            "Bridge Aktif",
                            "Görev çubuğundan sağ tıklayıp 'Bağlantı Kur' ile 30 saniyelik eşleştirme kodu alabilirsiniz.",
                            ToolTipIcon.None
                        );
                    }
                }
            }
            catch { }
        }

        // server.js keeps its state in C:\ProgramData\Bridge\data (fallback: %LOCALAPPDATA%\Bridge\data)
        private string DataFilePath(string name)
        {
            foreach (string dirName in new[] { Program.APP_DIR_NAME, Program.OLD_APP_DIR_NAME })
            {
                foreach (var root in new[] { Environment.SpecialFolder.CommonApplicationData, Environment.SpecialFolder.LocalApplicationData })
                {
                    try
                    {
                        string candidate = Path.Combine(Environment.GetFolderPath(root), dirName, "data", name);
                        if (File.Exists(candidate)) return candidate;
                    }
                    catch { }
                }
            }
            return Path.Combine(agentDir, "data", name);
        }

        // Shared secret written by server.js; required for pairing-code rotation and session revocation
        private string ReadAdminKey()
        {
            try
            {
                return File.ReadAllText(DataFilePath("admin.key"), Encoding.UTF8).Trim();
            }
            catch
            {
                return "";
            }
        }

        private void TriggerLocalApi(string path)
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + currentPort + path);
                    req.Method = "POST";
                    req.Headers["X-TahaBLT-Admin"] = ReadAdminKey();
                    req.Timeout = 2000;
                    req.ContentLength = 0;
                    using (var resp = req.GetResponse()) { }
                }
                catch { }
            });
        }

        private void CheckForUpdatesFromTray()
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + currentPort + "/api/update/check");
                    req.Method = "POST";
                    req.Headers["X-TahaBLT-Admin"] = ReadAdminKey();
                    req.Timeout = 8000;
                    req.ContentLength = 0;
                    using (var resp = req.GetResponse())
                    using (var reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                    {
                        string body = reader.ReadToEnd();
                        var serializer = new JavaScriptSerializer();
                        var parsed = serializer.Deserialize<Dictionary<string, object>>(body);
                        if (parsed != null)
                        {
                            bool hasUpdate = parsed.ContainsKey("updateAvailable") && Convert.ToBoolean(parsed["updateAvailable"]);
                            string curVer = parsed.ContainsKey("currentVersion") ? Convert.ToString(parsed["currentVersion"]) : "";
                            string latVer = parsed.ContainsKey("latestVersion") ? Convert.ToString(parsed["latestVersion"]) : "";

                            if (hasUpdate)
                            {
                                DialogResult dr = MessageBox.Show(
                                    "Yeni bir Bridge sürümü mevcut!\n\nMevcut Sürüm: v" + curVer + "\nYeni Sürüm: v" + latVer + "\n\nŞimdi otomatik indirip güncellemek ister misiniz?",
                                    "Bridge Güncelleme",
                                    MessageBoxButtons.YesNo,
                                    MessageBoxIcon.Information
                                );
                                if (dr == DialogResult.Yes)
                                {
                                    trayIcon.ShowBalloonTip(2500, "Bridge Güncelleniyor", "v" + latVer + " indiriliyor ve kuruluyor...", ToolTipIcon.None);
                                    TriggerLocalApi("/api/update/perform");
                                }
                            }
                            else
                            {
                                trayIcon.ShowBalloonTip(2500, "Bridge Güncel", "En güncel sürümü (v" + curVer + ") kullanıyorsunuz.", ToolTipIcon.None);
                            }
                        }
                    }
                }
                catch
                {
                    try
                    {
                        trayIcon.ShowBalloonTip(2500, "Güncelleme Denetimi", "GitHub sunucusuna şu anda ulaşılamadı.", ToolTipIcon.None);
                    }
                    catch { }
                }
            });
        }

        private bool IsStartupEnabled()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RUN_KEY, true))
                {
                    if (key == null) return false;
                    if (key.GetValue(OLD_APP_REG_NAME) != null)
                    {
                        key.DeleteValue(OLD_APP_REG_NAME, false);
                        key.SetValue(APP_REG_NAME, "\"" + Application.ExecutablePath + "\"");
                    }
                    return key.GetValue(APP_REG_NAME) != null;
                }
            }
            catch { return false; }
        }

        private void SetStartupEnabled(bool enable)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RUN_KEY, true))
                {
                    if (key == null) return;
                    if (enable)
                    {
                        string exePath = Application.ExecutablePath;
                        key.SetValue(APP_REG_NAME, "\"" + exePath + "\"");
                    }
                    else
                    {
                        key.DeleteValue(APP_REG_NAME, false);
                    }
                }
            }
            catch { }
        }

        private void ExitApplication()
        {
            isExiting = true;
            refreshTimer.Stop();
            if (reopenMenuTimer != null) reopenMenuTimer.Stop();
            trayIcon.Visible = false;
            StopNodeAgent();
            Application.Exit();
        }
    }

    public class BridgeBootService : ServiceBase
    {
        private Thread workerThread;
        private volatile bool stopping = false;
        private int activeChildPid = 0;
        private int activeUserTrayPid = 0;
        private uint activeSessionId = 0xFFFFFFFF;
        private long lastTrayCheckTick = 0;

        [DllImport("kernel32.dll")]
        public static extern uint WTSGetActiveConsoleSessionId();

        [DllImport("wtsapi32.dll", SetLastError = true)]
        private static extern bool WTSQueryUserToken(uint SessionId, out IntPtr phToken);

        [DllImport("userenv.dll", SetLastError = true)]
        private static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);

        [DllImport("userenv.dll", SetLastError = true)]
        private static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        private static extern bool DuplicateTokenEx(
            IntPtr hExistingToken,
            uint dwDesiredAccess,
            IntPtr lpTokenAttributes,
            int ImpersonationLevel,
            int TokenType,
            out IntPtr phNewToken
        );

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool SetTokenInformation(IntPtr TokenHandle, int TokenInformationClass, ref uint TokenInformation, int TokenInformationLength);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CreateProcessAsUserW(
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
        private static extern bool CloseHandle(IntPtr hObject);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
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
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        public BridgeBootService()
        {
            this.ServiceName = Program.SERVICE_NAME;
            this.CanStop = true;
            this.CanShutdown = true;
            this.AutoLog = false;
        }

        protected override void OnStart(string[] args)
        {
            stopping = false;
            workerThread = new Thread(ServiceLoop) { IsBackground = true };
            workerThread.Start();
        }

        protected override void OnStop()
        {
            stopping = true;
            KillActiveChild();
        }

        protected override void OnShutdown()
        {
            stopping = true;
            KillActiveChild();
        }

        private void KillActiveChild()
        {
            if (activeChildPid > 0)
            {
                try
                {
                    Process p = Process.GetProcessById(activeChildPid);
                    p.Kill();
                    p.WaitForExit(1500);
                }
                catch { }
                activeChildPid = 0;
            }
            try
            {
                foreach (var p in Program.FindHelperProcesses())
                {
                    try { p.Kill(); } catch { }
                }
            }
            catch { }
        }

        private bool IsChildAlive()
        {
            if (activeChildPid <= 0) return false;
            try
            {
                Process p = Process.GetProcessById(activeChildPid);
                return !p.HasExited;
            }
            catch
            {
                return false;
            }
        }

        private void ServiceLoop()
        {
            Program.ApplySystemWakeOnLanAndDataPermissions();

            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string agentDir = Path.Combine(baseDir, "pc-agent");
            if (!Directory.Exists(agentDir))
            {
                if (File.Exists(Path.Combine(baseDir, "server.js")))
                    agentDir = baseDir;
                else if (File.Exists(Path.Combine(baseDir, "..", "server.js")))
                    agentDir = Path.GetFullPath(Path.Combine(baseDir, ".."));
            }

            string serverScript = Path.Combine(agentDir, "server.js");
            string nodeExe = "node.exe";
            string bundledNode1 = Path.Combine(agentDir, "native", "node.exe");
            string bundledNode2 = Path.Combine(baseDir, "node.exe");
            string progFilesNode = @"C:\Program Files\nodejs\node.exe";
            if (File.Exists(bundledNode1)) nodeExe = bundledNode1;
            else if (File.Exists(bundledNode2)) nodeExe = bundledNode2;
            else if (File.Exists(progFilesNode)) nodeExe = progFilesNode;

            while (!stopping)
            {
                try
                {
                    uint consoleSession = WTSGetActiveConsoleSessionId();
                    if (consoleSession != 0xFFFFFFFF && consoleSession != 0)
                    {
                        if (!IsChildAlive() || consoleSession != activeSessionId)
                        {
                            KillActiveChild();
                            int spawnedPid = SpawnSystemAgentInConsoleSession(consoleSession, nodeExe, serverScript, agentDir);
                            if (spawnedPid > 0)
                            {
                                activeChildPid = spawnedPid;
                                activeSessionId = consoleSession;
                            }
                        }

                        long nowTick = Environment.TickCount;
                        if (Math.Abs(nowTick - lastTrayCheckTick) >= 5000)
                        {
                            lastTrayCheckTick = nowTick;
                            EnsureUserTrayInConsoleSession(consoleSession);
                        }
                    }
                }
                catch { }

                for (int i = 0; i < 30 && !stopping; i++)
                {
                    Thread.Sleep(100);
                }
            }
        }

        private void EnsureUserTrayInConsoleSession(uint sessionId)
        {
            try
            {
                if (activeUserTrayPid > 0)
                {
                    try
                    {
                        Process p = Process.GetProcessById(activeUserTrayPid);
                        if (p != null && !p.HasExited && (uint)p.SessionId == sessionId) return;
                    }
                    catch { activeUserTrayPid = 0; }
                }

                // Only spawn the user tray icon if explorer.exe is running in the interactive user session
                bool explorerRunning = false;
                foreach (var exp in Process.GetProcessesByName("explorer"))
                {
                    if ((uint)exp.SessionId == sessionId) { explorerRunning = true; break; }
                }
                if (!explorerRunning) return;

                string ownExe = Application.ExecutablePath;
                string ownName = Path.GetFileNameWithoutExtension(ownExe);
                foreach (var p in Process.GetProcessesByName(ownName))
                {
                    if (p.Id != Process.GetCurrentProcess().Id && (uint)p.SessionId == sessionId)
                    {
                        activeUserTrayPid = p.Id;
                        return;
                    }
                }

                int pid = SpawnUserTrayInConsoleSession(sessionId, ownExe);
                if (pid > 0) activeUserTrayPid = pid;
            }
            catch { }
        }

        public static int SpawnUserTrayInConsoleSession(uint sessionId, string trayExePath)
        {
            if (sessionId == 0xFFFFFFFF || sessionId == 0 || string.IsNullOrEmpty(trayExePath) || !File.Exists(trayExePath))
                return 0;

            IntPtr userToken = IntPtr.Zero;
            IntPtr primaryToken = IntPtr.Zero;
            IntPtr envBlock = IntPtr.Zero;
            try
            {
                if (!WTSQueryUserToken(sessionId, out userToken) || userToken == IntPtr.Zero)
                    return 0;
                if (!DuplicateTokenEx(userToken, 0xF01FF, IntPtr.Zero, 2, 1, out primaryToken) || primaryToken == IntPtr.Zero)
                    return 0;
                CreateEnvironmentBlock(out envBlock, primaryToken, false);

                STARTUPINFO si = new STARTUPINFO();
                si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                si.lpDesktop = @"winsta0\default";

                StringBuilder cmdLine = new StringBuilder();
                cmdLine.Append("\"").Append(trayExePath).Append("\"");

                uint creationFlags = 0x00000400; // CREATE_UNICODE_ENVIRONMENT
                PROCESS_INFORMATION pi;
                if (CreateProcessAsUserW(primaryToken, null, cmdLine, IntPtr.Zero, IntPtr.Zero, false, creationFlags, envBlock, Path.GetDirectoryName(trayExePath), ref si, out pi))
                {
                    int pid = pi.dwProcessId;
                    if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
                    if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
                    return pid;
                }
            }
            catch { }
            finally
            {
                if (envBlock != IntPtr.Zero) try { DestroyEnvironmentBlock(envBlock); } catch { }
                if (primaryToken != IntPtr.Zero) try { CloseHandle(primaryToken); } catch { }
                if (userToken != IntPtr.Zero) try { CloseHandle(userToken); } catch { }
            }
            return 0;
        }

        private int SpawnSystemAgentInConsoleSession(uint sessionId, string nodeExe, string serverScript, string workingDir)
        {
            IntPtr hToken = IntPtr.Zero;
            IntPtr hDupToken = IntPtr.Zero;
            try
            {
                if (!OpenProcessToken(GetCurrentProcess(), 0xF01FF, out hToken) || hToken == IntPtr.Zero)
                    return 0;

                // SecurityIdentification (2), TokenPrimary (1), TOKEN_ALL_ACCESS (0xF01FF)
                if (!DuplicateTokenEx(hToken, 0xF01FF, IntPtr.Zero, 2, 1, out hDupToken) || hDupToken == IntPtr.Zero)
                    return 0;

                // TokenSessionId = 12 -> move SYSTEM primary token into the active Console Session (1, 2, ...)
                uint targetSession = sessionId;
                if (!SetTokenInformation(hDupToken, 12, ref targetSession, sizeof(uint)))
                    return 0;

                STARTUPINFO si = new STARTUPINFO();
                si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                si.lpDesktop = @"winsta0\default";
                si.dwFlags = 0x00000001; // STARTF_USESHOWWINDOW
                si.wShowWindow = 0; // SW_HIDE

                StringBuilder cmdLine = new StringBuilder();
                cmdLine.Append("\"").Append(nodeExe).Append("\" \"").Append(serverScript).Append("\" --parent-pid ").Append(Process.GetCurrentProcess().Id);

                uint creationFlags = 0x08000000 | 0x00000400; // CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT
                PROCESS_INFORMATION pi;
                if (CreateProcessAsUserW(hDupToken, null, cmdLine, IntPtr.Zero, IntPtr.Zero, false, creationFlags, IntPtr.Zero, workingDir, ref si, out pi))
                {
                    int pid = pi.dwProcessId;
                    if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
                    if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
                    return pid;
                }
            }
            catch { }
            finally
            {
                if (hDupToken != IntPtr.Zero) CloseHandle(hDupToken);
                if (hToken != IntPtr.Zero) CloseHandle(hToken);
            }
            return 0;
        }
    }

    public static class Program
    {
        public const string APP_DIR_NAME = "Bridge";
        public const string OLD_APP_DIR_NAME = "TahaBLT Connect";
        public const string SERVICE_NAME = "BridgeService";
        public const string OLD_SERVICE_NAME = "TahaBLTConnectService";

        // Agent helper processes, current and pre-rebrand names. "Bridge" is a common word, so for the new names
        // only processes running from this install folder are matched.
        public static List<Process> FindHelperProcesses()
        {
            var found = new List<Process>();
            try { found.AddRange(Process.GetProcessesByName("TahaBLTBridge")); } catch { }
            try
            {
                string ownDir = Path.GetDirectoryName(Application.ExecutablePath) ?? "";
                foreach (var p in Process.GetProcessesByName("BridgeHelper"))
                {
                    try
                    {
                        if (p.MainModule.FileName.StartsWith(ownDir, StringComparison.OrdinalIgnoreCase)) found.Add(p);
                    }
                    catch { }
                }
            }
            catch { }
            return found;
        }

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        public static void ApplySystemWakeOnLanAndDataPermissions()
        {
            try
            {
                string progDataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), APP_DIR_NAME, "data");
                Directory.CreateDirectory(progDataDir);

                // Grant Users full read/write access to C:\ProgramData\Bridge so TrayApp and SYSTEM service share state seamlessly
                try
                {
                    Process icacls = Process.Start(new ProcessStartInfo
                    {
                        FileName = "icacls.exe",
                        Arguments = "\"" + Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), APP_DIR_NAME) + "\" /grant *S-1-5-32-545:(OI)(CI)F /T /C /Q",
                        CreateNoWindow = true,
                        UseShellExecute = false,
                        WindowStyle = ProcessWindowStyle.Hidden
                    });
                    if (icacls != null) icacls.WaitForExit(3000);
                }
                catch { }

                // Migrate pairing state from the pre-rebrand ProgramData folder or a user's %LOCALAPPDATA% if
                // ProgramData\Bridge has no config.json yet
                string targetCfg = Path.Combine(progDataDir, "config.json");
                if (!File.Exists(targetCfg))
                {
                    try
                    {
                        var candidates = new List<string>();
                        candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), OLD_APP_DIR_NAME, "data"));
                        foreach (var userDir in Directory.GetDirectories(@"C:\Users"))
                        {
                            candidates.Add(Path.Combine(userDir, "AppData", "Local", APP_DIR_NAME, "data"));
                            candidates.Add(Path.Combine(userDir, "AppData", "Local", OLD_APP_DIR_NAME, "data"));
                        }
                        foreach (var candidate in candidates)
                        {
                            if (File.Exists(Path.Combine(candidate, "config.json")))
                            {
                                foreach (var f in Directory.GetFiles(candidate))
                                {
                                    string dst = Path.Combine(progDataDir, Path.GetFileName(f));
                                    if (!File.Exists(dst)) File.Copy(f, dst, false);
                                }
                                break;
                            }
                        }
                    }
                    catch { }
                }

                // Disable Fast Startup (HiberbootEnabled = 0) so Windows S5 shutdown leaves NIC armed for Wake-on-LAN Magic Packet
                try
                {
                    using (var powerKey = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Session Manager\Power", true))
                    {
                        if (powerKey != null) powerKey.SetValue("HiberbootEnabled", 0, RegistryValueKind.DWord);
                    }
                }
                catch { }

                // Enable Wake-on-LAN in NIC driver registry keys under HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e972-e325-11ce-bfc1-08002be10318}
                try
                {
                    using (var netClass = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Class\{4d36e972-e325-11ce-bfc1-08002be10318}", true))
                    {
                        if (netClass != null)
                        {
                            foreach (var subName in netClass.GetSubKeyNames())
                            {
                                if (subName.Length != 4 || !char.IsDigit(subName[0])) continue;
                                try
                                {
                                    using (var nicKey = netClass.OpenSubKey(subName, true))
                                    {
                                        if (nicKey == null) continue;
                                        object wakeVal = nicKey.GetValue("*WakeOnMagicPacket");
                                        object s5Val = nicKey.GetValue("S5WakeOnLan");
                                        if (wakeVal != null || s5Val != null)
                                        {
                                            nicKey.SetValue("*WakeOnMagicPacket", "1", RegistryValueKind.String);
                                            nicKey.SetValue("*WakeOnPattern", "1", RegistryValueKind.String);
                                            if (nicKey.GetValue("*ModernStandbyWoLMagicPacket") != null)
                                                nicKey.SetValue("*ModernStandbyWoLMagicPacket", "1", RegistryValueKind.String);
                                            if (s5Val != null)
                                                nicKey.SetValue("S5WakeOnLan", "1", RegistryValueKind.String);
                                            if (nicKey.GetValue("WakeOnMagicPacket") != null)
                                                nicKey.SetValue("WakeOnMagicPacket", "1", RegistryValueKind.String);
                                            if (nicKey.GetValue("ShutdownWake") != null)
                                                nicKey.SetValue("ShutdownWake", "1", RegistryValueKind.String);
                                            if (nicKey.GetValue("*EEE") != null)
                                                nicKey.SetValue("*EEE", "0", RegistryValueKind.String);
                                            if (nicKey.GetValue("EEE") != null)
                                                nicKey.SetValue("EEE", "0", RegistryValueKind.String);
                                            if (nicKey.GetValue("AdvancedEEE") != null)
                                                nicKey.SetValue("AdvancedEEE", "0", RegistryValueKind.String);
                                            if (nicKey.GetValue("GreenEthernet") != null)
                                                nicKey.SetValue("GreenEthernet", "0", RegistryValueKind.String);
                                            if (nicKey.GetValue("PowerSavingMode") != null)
                                                nicKey.SetValue("PowerSavingMode", "0", RegistryValueKind.String);
                                            // PnPCapabilities = 0x100 (256): Allow this device to wake the computer, do NOT allow Windows to turn off device to save power
                                            nicKey.SetValue("PnPCapabilities", 256, RegistryValueKind.DWord);
                                        }
                                    }
                                }
                                catch { }
                            }
                        }
                    }
                }
                catch { }

                // Apply live via PowerShell & powercfg so it takes effect immediately without requiring a reboot
                try
                {
                    string psCmd = "Get-NetAdapter -Physical -ErrorAction SilentlyContinue | ForEach-Object { " +
                                   "$n = $_.Name; $d = $_.InterfaceDescription; " +
                                   "try { Set-NetAdapterAdvancedProperty -Name $n -RegistryKeyword '*WakeOnMagicPacket' -RegistryValue 1 -ErrorAction SilentlyContinue } catch {}; " +
                                   "try { Set-NetAdapterAdvancedProperty -Name $n -RegistryKeyword '*ModernStandbyWoLMagicPacket' -RegistryValue 1 -ErrorAction SilentlyContinue } catch {}; " +
                                   "try { Set-NetAdapterAdvancedProperty -Name $n -RegistryKeyword 'S5WakeOnLan' -RegistryValue 1 -ErrorAction SilentlyContinue } catch {}; " +
                                   "try { Enable-NetAdapterPowerManagement -Name $n -WakeOnMagicPacket -WakeOnPattern -ErrorAction SilentlyContinue } catch {}; " +
                                   "try { powercfg /deviceenablewake \"$d\" | Out-Null } catch {}; " +
                                   "}";
                    Process ps = Process.Start(new ProcessStartInfo
                    {
                        FileName = "powershell.exe",
                        Arguments = "-NoProfile -WindowStyle Hidden -Command \"" + psCmd + "\"",
                        CreateNoWindow = true,
                        UseShellExecute = false,
                        WindowStyle = ProcessWindowStyle.Hidden
                    });
                    if (ps != null) ps.WaitForExit(8000);
                }
                catch { }
            }
            catch { }
        }

        private static void RunSystemSetupElevated()
        {
            ApplySystemWakeOnLanAndDataPermissions();

            try
            {
                string exePath = Application.ExecutablePath;
                string binPathArg = "\\\"" + exePath + "\\\" --service";

                // Stop and delete the service (also the one from before the rebrand), then create and start it again
                foreach (string name in new[] { OLD_SERVICE_NAME, SERVICE_NAME })
                {
                    RunHiddenCmd("sc.exe", "stop " + name, 2500);
                    Thread.Sleep(300);
                    RunHiddenCmd("sc.exe", "delete " + name, 2500);
                    Thread.Sleep(300);
                }
                RunHiddenCmd("sc.exe", "create " + SERVICE_NAME + " binPath= \"" + binPathArg + "\" start= auto obj= LocalSystem DisplayName= \"Bridge\"", 4000);
                RunHiddenCmd("sc.exe", "description " + SERVICE_NAME + " \"Bridge: telefondan erisim ve kilit ekrani (oturum acilmadan once) servisi.\"", 2000);
                RunHiddenCmd("sc.exe", "failure " + SERVICE_NAME + " reset= 0 actions= restart/2000/restart/2000/restart/2000", 2000);
                RunHiddenCmd("sc.exe", "start " + SERVICE_NAME, 5000);
            }
            catch { }
        }

        private static void RunHiddenCmd(string file, string args, int timeoutMs)
        {
            try
            {
                Process p = Process.Start(new ProcessStartInfo
                {
                    FileName = file,
                    Arguments = args,
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    WindowStyle = ProcessWindowStyle.Hidden
                });
                if (p != null) p.WaitForExit(timeoutMs);
            }
            catch { }
        }

        public static bool IsSystemServiceInstalledAndRunning()
        {
            try
            {
                using (ServiceController sc = new ServiceController(SERVICE_NAME))
                {
                    return sc.Status == ServiceControllerStatus.Running || sc.Status == ServiceControllerStatus.StartPending;
                }
            }
            catch
            {
                return false;
            }
        }

        public static bool IsNicWakeOnLanConfigured()
        {
            try
            {
                using (var netClass = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Class\{4d36e972-e325-11ce-bfc1-08002be10318}", false))
                {
                    if (netClass == null) return true;
                    foreach (var subName in netClass.GetSubKeyNames())
                    {
                        if (subName.Length != 4 || !char.IsDigit(subName[0])) continue;
                        using (var nicKey = netClass.OpenSubKey(subName, false))
                        {
                            if (nicKey == null) continue;
                            object wakeVal = nicKey.GetValue("*WakeOnMagicPacket");
                            if (wakeVal != null && Convert.ToString(wakeVal) == "0")
                            {
                                return false;
                            }
                        }
                    }
                }
            }
            catch { }
            return true;
        }

        private static void TerminatePreviousTrayInstancesOnly(bool killAgentToo)
        {
            int selfPid = Process.GetCurrentProcess().Id;

            try
            {
                var trays = new List<Process>(Process.GetProcessesByName("TahaBLT-Connect"));
                trays.AddRange(Process.GetProcessesByName(Path.GetFileNameWithoutExtension(Application.ExecutablePath)));
                foreach (var p in trays)
                {
                    if (p.Id != selfPid && p.SessionId == Process.GetCurrentProcess().SessionId)
                    {
                        try { p.Kill(); p.WaitForExit(1000); } catch { }
                    }
                }
            }
            catch { }

            if (!killAgentToo) return;

            try
            {
                foreach (var p in FindHelperProcesses())
                {
                    try { p.Kill(); p.WaitForExit(800); } catch { }
                }
            }
            catch { }

            try
            {
                Process netstat = new Process();
                netstat.StartInfo.FileName = "cmd.exe";
                netstat.StartInfo.Arguments = "/c for /f \"tokens=5\" %a in ('netstat -aon ^| findstr \":4850 \" ^| findstr \"LISTENING\"') do @taskkill /F /PID %a";
                netstat.StartInfo.CreateNoWindow = true;
                netstat.StartInfo.UseShellExecute = false;
                netstat.StartInfo.WindowStyle = ProcessWindowStyle.Hidden;
                netstat.Start();
                netstat.WaitForExit(2000);
            }
            catch { }
        }

        [STAThread]
        public static void Main(string[] args)
        {
            if (args != null && args.Length > 0)
            {
                if (args[0] == "--service")
                {
                    ServiceBase.Run(new ServiceBase[] { new BridgeBootService() });
                    return;
                }
                if (args[0] == "--setup-system")
                {
                    RunSystemSetupElevated();
                    return;
                }
                if (args[0] == "--uninstall-system")
                {
                    foreach (string name in new[] { SERVICE_NAME, OLD_SERVICE_NAME })
                    {
                        RunHiddenCmd("sc.exe", "stop " + name, 3000);
                        RunHiddenCmd("sc.exe", "delete " + name, 3000);
                    }
                    return;
                }
            }

            try { SetProcessDPIAware(); } catch { }

            // If launched under SYSTEM without --service (e.g. by self-updater), re-spawn under the interactive logged-in user token so Windows 11 displays the NotifyIcon in the user's taskbar
            try
            {
                if (System.Security.Principal.WindowsIdentity.GetCurrent().IsSystem)
                {
                    uint consoleSession = BridgeBootService.WTSGetActiveConsoleSessionId();
                    if (consoleSession != 0 && consoleSession != 0xFFFFFFFF)
                    {
                        BridgeBootService.SpawnUserTrayInConsoleSession(consoleSession, Application.ExecutablePath);
                    }
                    return;
                }
            }
            catch { }

            // Ensure the pre-login Windows Service (BridgeService) and NIC Wake-on-LAN are configured
            if (!IsSystemServiceInstalledAndRunning() || !IsNicWakeOnLanConfigured())
            {
                try
                {
                    Process setupProc = Process.Start(new ProcessStartInfo
                    {
                        FileName = Application.ExecutablePath,
                        Arguments = "--setup-system",
                        Verb = "runas",
                        UseShellExecute = true,
                        WindowStyle = ProcessWindowStyle.Hidden
                    });
                    if (setupProc != null) setupProc.WaitForExit(12000);
                }
                catch { }
            }

            bool serviceRunning = IsSystemServiceInstalledAndRunning();
            TerminatePreviousTrayInstancesOnly(!serviceRunning);
            Thread.Sleep(250);

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayApp());
        }
    }
}
