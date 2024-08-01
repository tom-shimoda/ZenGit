# ZenGit
[English](./README_en.md)
<div style="text-align: center;">
    <img src="./readme_images/icon.png" width="30%">
</div>

**軽快な動作を目指したシンプルなgitクライアントです。**  

(※ [git](https://git-scm.com/)は内包しておらず、別途インストールする必要があります。)

## 機能説明

## メニュー
<img src="./readme_images/menu.png" width="40%">

- **タイトルバー**: 現在開いているgitプロジェクトフォルダが表示されます。
- **Open**: 操作対象のgitプロジェクトフォルダを選択します。
- **Fetch**: fetchします。(マージはしません)
- **Pull**: pullします。リモートブランチが現在のブランチより進んでいる数が表示されます。
- **Push**: プッシュします。現在のブランチがリモートブランチより進んでいる数が表示されます。

## モード
<img src="./readme_images/mode.png" width="15%">

- **commitモード**: コミット関連の操作を行うモードです。
- **logモード**: ログの表示や、ブランチ操作を行うモードです。

## commitモード
<img src="./readme_images/commit_mode.png" width="80%">

コミット操作や変更差分の表示を行います。

### 変更ファイル一覧
<img src="./readme_images/changefile_panel.png" width="30%">

このパネルには差分ファイルが表示されます。変更内容は、ファイル名の先頭の文字で判断できます。
```
M: 変更
A: 追加
D: 削除
```

### コミット方法
コミットしたいファイルにチェックを入れ、コミットメッセージを入力した後、commitボタンでコミットすることができます。

> [!NOTE]
> コミットメッセージに何も入力せずにcommitボタンを押した場合は、前回のコミットにまとめてコミットすることができます。

### 右クリックメニュー
- 変更を破棄: 変更を破棄します。ファイル追加差分の場合はそのファイルを削除します。
- ファイルの場所を開く: ファイルの場所をエクスプローラーで開きます。

### 差分表示パネル
- **unified**: 通常の差分表示を行います。

<img src="./readme_images/unified.png" width="40%">

- **side by side**: サイド・バイ・サイドで差分表示を行います。

<img src="./readme_images/sidebyside.png" width="40%">

## logモード
<img src="./readme_images/log_mode.png" width="80%">

全ブランチが一覧表示され、そのログが表示されます。

### ブランチパネル
<img src="./readme_images/branch_panel.png" width="30%">

各ブランチをクリックすることで、そのブランチのログ表示に切り替わります。
- [All]を選択すると、全ブランチのログ表示を行います。
- 目玉アイコンがついているブランチが現在ログ表示を行っているブランチです。
- "xxxx ← HEAD"と表記されているブランチが、現在チェックアウトしているブランチです。
- "remotes/"から始まるブランチはリモートブランチです。

#### 右クリックメニュー
ローカルブランチとリモートブランチで右クリックメニュー内容が少し異なります。
- **チェックアウト**: 選択したブランチにチェックアウトします。リモートブランチを選択した場合は同名のローカルブランチを作成し、チェックアウトします。
- **現在のブランチにこのブランチをマージ**: 右クリックしたブランチを現在チェックアウトしているブランチ(HEAD表記のあるブランチ)にマージします。
- **削除**: ブランチを削除します。

### ログパネル
ハッシュボタンを押すと、そのコミットの変更内容を別ウィンドウで表示します。

#### [Normal <-> Only logs for this branch]スイッチ
- **Normal**: 通常のログ表示を行います  
- **Only logs for this branch**: そのブランチのログのみ表示します。マージ済みの別ブランチのコミットログは表示されなくなります。

#### 右クリックメニュー
1. ログ上での右クリックメニューより、特定のコミットにチェックアウトすることができます。
<div style="text-align: center;">
    <img src="./readme_images/log_contextmenu.png" width="50%">
</div>

2. 特定のコミットにチェックアウトするとブランチパネルがこのような表示になります。この状態でコミットを行うことはできません。編集してコミットを行いたい場合は、現在の状態から新規ブランチを作成し、そのブランチ上で作業を行ってください。(この特定コミットから分岐する形でブランチが生成されます。)
<div style="text-align: center;">
    <img src="./readme_images/log_contextmenu2.png" width="20%">
</div>

3. この状態で別のブランチをチェックアウトすることで、通常状態に戻ります。
<div style="text-align: center;">
    <img src="./readme_images/log_contextmenu3.png" width="20%">
</div>
<div style="text-align: center;">
    <img src="./readme_images/log_contextmenu4.png" width="20%">
</div>

---

> [!NOTE]
> このアプリケーションは以下のパスに"ZenGit"という名前のキャッシュフォルダを作成します。
> アプリケーションが正常に動かない場合はキャッシュフォルダを試してください。
> ```
> Windows: $HOME\AppData\Roaming\
> macOS: $HOME/Library/Application Support/
> Linux: $XDG_CONFIG_HOME or $HOME/.config/  (※未確認)
> ```

---

## ビルド手順
[手順](./how_to_build.md)

---
[ライセンス](./LICENSE)