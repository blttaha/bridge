<p align="center">
  <img src="mobile-app/branding/bridge-logo.png" width="96" height="96" alt="Bridge" />
</p>

<h1 align="center">Bridge</h1>

<p align="center">
  Windows ve Linux bilgisayarlar için yerel ağ ve tünel destekli Android uzaktan kontrol istemcisi.
</p>

---

## Genel Bakış

Bridge; aynı yerel ağ (LAN/Wi-Fi), mobil erişim noktası, Tailscale veya Cloudflare tüneli üzerinden bilgisayarınızı Android telefonunuzdan yönetmenizi sağlar. Görev çubuğundan üretilen 30 saniyelik tek kullanımlık kod ile eşleşir.

### Temel İşlevler

- **Uzaktan Masaüstü:** Donanım hızlandırmalı AV1 / H.264 akışı (DXGI Desktop Duplication), durağan karelerde kayıpsız bölge netleştirme, gerçek Windows dokunma enjeksiyonu (`InjectTouchInput`), izleme dörtgeni (trackpad) modu ve canlı klavye.
- **Ekran ve Pencere Yönetimi:** Çoklu monitör güç/karartma/parlaklık kontrolü, ekran topolojisi (uzat, yinele, tek ekran), açık pencereleri ekranlar ve bölgeler arasında taşıma, kayıtlı çalışma sahneleri.
- **Medya ve Ses:** Windows GSMTC / Linux MPRIS medya oturumu kontrolü, Android bildirim panelinde canlı medya oynatıcı, ana ses ve uygulama bazlı ses mikseri (WASAPI / PulseAudio).
- **Sistem ve Güç:** Ekran kilidi, uyku, hazırda bekletme, kapatma, yeniden başlatma, zamanlayıcı, Wake-on-LAN (WoL) ve çift yönlü pano geçmişi (metin ve görsel).
- **Android Hızlı Ayarlar:** Bildirim çubuğundan uygulamayı açmadan tek dokunuşla ekran açma/karartma, kilitleme, uyku ve kapatma kutucukları.

---

## Kurulum

### Windows (10 / 11 x64)

1. [`Bridge-Setup.exe`](Bridge-Setup.exe) kurulum paketini çalıştırın.
2. Kurulum tamamlandığında sistem tepsisinde (sağ alt görev çubuğu) **Bridge** simgesi çalışmaya başlar.

### Linux (X11)

```bash
mkdir bridge && tar -xzf Bridge-Linux.tar.gz -C bridge
bash bridge/install.sh
```

Eşleştirme kodu üretmek ve servis durumunu görmek için:

```bash
bridgectl pair
bridgectl status
```

### Android (7.0+)

[`Bridge.apk`](Bridge.apk) dosyasını telefonunuza kurun. Bilgisayarda görev çubuğundaki Bridge simgesine sağ tıklayıp **Bağlantı Kur (30 sn Kod Oluştur)** seçeneğine basın ve ekrandaki 8 haneli kodu telefona girin.

---

## Kaynaktan Derleme

```powershell
# 1. Node.js bağımlılıkları
cd pc-agent
npm install

# 2. Windows yerel bileşenleri (BridgeHelper.exe ve Bridge.exe)
powershell -ExecutionPolicy Bypass -File native\build-native.ps1

# 3. Android APK
powershell -ExecutionPolicy Bypass -File ..\mobile-app\build-apk.ps1

# 4. Linux dağıtım paketi (Bridge-Linux.tar.gz)
node linux\build-package.js
```

---

## Ağ Portları

| Port | Protokol | Kapsam | Açıklama |
| :--- | :--- | :--- | :--- |
| `4850` | TCP | `0.0.0.0` | HTTP API ve WebSocket sunucusu |
| `4851` | UDP | `0.0.0.0` | Yerel ağ cihaz keşfi (LAN Discovery) |
| `4852` | TCP | `127.0.0.1` | Yerel ekran yakalama akış kanalı |
| `4853` | TCP | `127.0.0.1` | Yerel düşük gecikmeli girdi kanalı |
| `4855` | TCP | `127.0.0.1` | Cloudflare tüneli yerel giriş noktası |

---

## Dizin Yapısı

```text
├── Bridge-Setup.exe          Windows kurulum paketi
├── Bridge-Linux.tar.gz       Linux kurulum arşivi
├── Bridge.apk                Android kurulum paketi
├── Bridge.exe                Windows görev çubuğu istemcisi
├── pc-agent/
│   ├── server.js             HTTP / WebSocket sunucusu ve oturum yönetimi
│   ├── installer.iss         Inno Setup kurulum betiği
│   ├── native/               Windows C# / Win32 / DXGI / WASAPI bileşenleri
│   └── linux/                Linux X11 / PulseAudio / systemd bileşenleri
└── mobile-app/
    ├── android/              Android yerel kabuğu, bildirim ve Hızlı Ayarlar servisleri
    └── www/                  Mobil arayüz katmanı
```
