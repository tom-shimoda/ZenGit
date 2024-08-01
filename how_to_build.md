# 1. 準備

## Windows
1. [scoop](https://scoop.sh/)と[chocolatey](https://chocolatey.org/)をインストール。  
(scoopのインストールは[管理者権限のpowershellで実行するとエラー](https://shigeo-t.hatenablog.com/entry/2022/06/13/050000)になるので注意。)
2. Tauriに必要なものをインストール
```
choco install visualstudio2022buildtools
choco install visualstudio2022-workload-vctools
```
[link](https://zenn.dev/suauiya/books/ef2d2c67c546361e4518/viewer/f25ab0480c5e6ec794e4)

```
# nodejs未インストールの場合
choco install nodejs

# nodejsインストール済みの場合 (バージョンが古いとエラーとなる → https://github.com/vitejs/vite/issues/14299)
choco update nodejs
```

```
scoop install rustup

rustup self update
rustup update
rustup install stable
```
[link](https://qiita.com/dozo/items/378452a0c3585f0756dc)

## Mac
1. [Homebrew](https://brew.sh/)をインストール
2. brewからrustupを入れる  
```
brew install rustup-init

# インストールできたら初期化
rustup-init
```
[link](https://zenn.dev/coco655/articles/rust_install)

---

# 2. Tauriプロジェクトの準備
```
cd <cloneしたZenGitフォルダ>

# 必要なnode moduleをプロジェクトフォルダにインストール
npm install
```

---

# 3. デバッグモードでアプリ実行
```
cd <cloneしたZenGitフォルダ>

# デバッグモードでアプリを実行
npm run tauri dev
```

---

# 4. ビルド
```
cd <cloneしたZenGitフォルダ>

npm run tauri build
```
ビルドが完了すると、`src-tauri\target\release\bundle\`内にインストーラが生成される。

---

# RustRoverで実行する場合
[設定方法](https://tauri.app/v1/guides/debugging/rustrover/)

設定後の実行方法

1. Run Dev Serverをビルド実行した状態にする
2. Run Tauri Appを実行

---

# Tips

- 実行時のアプリのブラウザデバッグ表示について [link](https://tauri.app/v1/guides/debugging/application/)
    - アプリウィンドウを右クリック > Inspect Element より開く (mac: ⌘ + ⌥ + i, win: ctrl + shift + i)
    - デバッグメニュー左側アイコンにドッキングを解除するボタンがある

- src-tauri/target/ は`npm run tauri dev`すると自動生成される。サイズがでかいので消してもよい

- releaseビルドでwebデバッガーを使用する方法 [link](https://github.com/tauri-apps/tauri/discussions/3638)
    - Cargo.tomlの[dependencies]tauri featuresに"devtools"を追加する
