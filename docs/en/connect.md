# Connect the apps

[Русская версия](../ru/connect.md)

Every device reaches a Quant server through its gate, with the username and password set at install. The apps store them and send them with every request, so you type them once.

## Browser

Open the server address, for example `http://192.168.1.10:8080`. The browser asks for the gate username and password, then shows the Quant sign-in page.

## Android

1. Open the latest [release](https://github.com/Quant-Ai-Assistant/Quant-Core/releases/latest) on the phone and download `quant.apk`.
2. Open the file. Android asks to allow installs from your browser or file manager the first time; allow it and install.
3. Start Quant and tap **Use a custom server**.
4. Enter the server address and, under it, the gate username and password, then tap **Save**.
5. Sign in with your Quant account.

A wrong password shows "The server did not accept that username and password". Plain `http://` addresses work only for local network addresses; a public server needs `https://`.

## macOS

1. Download the `.dmg` from the latest release: `arm64` for Apple Silicon, `x64` for Intel.
2. Open it and drag **Quant** into **Applications**.
3. Start Quant. macOS says it cannot verify the developer, because the app is not signed with an Apple Developer ID. Click **Done**.
4. Open **System Settings → Privacy & Security**, click **Open Anyway** next to the message about Quant and confirm.

The terminal does the same as step 4:

```sh
xattr -dr com.apple.quarantine /Applications/Quant.app
```

5. In the setup window choose **Existing instance**, enter the server address, the gate username and password, and click **Continue**.

The password is stored in the macOS keychain. To change server later, use **Change Quant Server…** in the app menu.

## Windows

Run the `.exe` installer from the latest release. SmartScreen warns about an unknown publisher: click **More info**, then **Run anyway**. Then choose **Existing instance** as on macOS.

## Linux

Download the `.AppImage`, make it executable and run it:

```sh
chmod +x Quant-*.AppImage
./Quant-*.AppImage
```

## Server on the desktop

The desktop app can run the Quant server itself on the same computer with Docker:

1. In the setup window choose **This computer**.
2. To reach it from a phone or another computer, fill in **Username for other devices** and **Password**. Leave them empty to keep the server to this computer.
3. Click **Continue**. The app downloads and starts Quant, then opens it.

With a username set, the setup window shows a tunnel address such as `http://localhost:8080`: the gate that asks other devices for that username and password. Point a tunnel (Cloudflare Tunnel, ngrok, Tailscale Funnel) at it and use the tunnel's public `https://` address on the phone, together with the same username and password. Devices on the same network can also use `http://<this computer's address>:8080`.

To change the username or password, or to close access, open **Change Quant Server…**, edit the fields under **This computer** and click **Continue**. Leave the password empty to keep the current one. A new password signs the other devices out of the gate.
