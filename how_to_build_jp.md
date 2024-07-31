# 0. 下準備 [参考](https://tauri.app/v1/guides/getting-started/prerequisites)

- Windows  
  [scoop](https://scoop.sh/)をインストール。  
  以下コマンドは変更されてる可能性があるので公式ページを参照すること。  
  また[管理者権限のpowershellで実行するとエラー](https://shigeo-t.hatenablog.com/entry/2022/06/13/050000)になるので注意。
    ```
    Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
    Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression
    ```

- Mac  
  brewからrustupを入れる
  公式ではcurlで入れているが、brewにもあるみたいなのでそちらからインストール
    ```
    brew install rustup-init

    # インストールできたら初期化
    rustup-init
    ```
  [参考](https://zenn.dev/coco655/articles/rust_install)

---

# 1. Tauriに必要なものをインストール

```
choco install visualstudio2022buildtools
choco install visualstudio2022-workload-vctools

choco install nodejs
# 既にインストール済みの場合、バージョンが古いとエラーとなるため
# 念のため`choco update nodejs`しておく(https://github.com/vitejs/vite/issues/14299)
```

[参考](https://zenn.dev/suauiya/books/ef2d2c67c546361e4518/viewer/f25ab0480c5e6ec794e4)

```
scoop install rustup

rustup self update
rustup update
rustup install stable
```

[参考](https://qiita.com/dozo/items/378452a0c3585f0756dc)

---

# 2. Tauriプロジェクトの作成

```
cd "プロジェクトフォルダを作成したい階層まで移動しておく"

# Tauriプロジェクト作成 **初回のみ。本リポジトリclone時は不要**
npm create tauri-app@latest

# 必要なnode moduleをプロジェクトフォルダにインストール **cloneしてきた際も必要**
npm install --save-dev @tauri-apps/cli

# 作成するアプリ情報を設定 **初回のみ。本リポジトリclone時は不要**
npm run tauri init

# デバッグモードでアプリを実行
npm run tauri dev
```

[参考](https://zenn.dev/kumassy/books/6e518fe09a86b2/viewer/521d6b)

---

# 3. ビルド
```
npm run tauri build
```
[参考](https://zenn.dev/de_teiu_tkg/articles/29ab64fe67a1af)

---

# RustRoverで実行する場合

[設定方法](https://tauri.app/v1/guides/debugging/rustrover/)

設定後の実行方法

1. Run Dev Serverをビルド実行した状態にする
2. Run Tauri Appを実行

---

# その他

- 実行時のアプリのブラウザデバッグ表示について [参考](https://tauri.app/v1/guides/debugging/application/)
    - アプリウィンドウを右クリック > Inspect Element より開く (mac: ⌘ + ⌥ + i, win: ctrl + shift + i)
    - デバッグメニュー左側アイコンにドッキングを解除するボタンがある

- src-tauri/target/ は`npm run tauri dev`すると自動生成される。サイズがでかいので消してもよい

- releaseビルドでwebデバッガーを使用する方法 [参考](https://github.com/tauri-apps/tauri/discussions/3638)
    - Cargo.tomlの[dependencies]tauri featuresに"devtools"を追加する
