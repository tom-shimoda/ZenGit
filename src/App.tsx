import "./App.scss"
import React, {useEffect, useRef, useState} from 'react';
import {invoke} from '@tauri-apps/api/tauri';
import {appWindow, getCurrent} from "@tauri-apps/api/window";
import {app, event} from "@tauri-apps/api";
import {Tab, TabList, Tabs} from "react-tabs";
import {ask} from "@tauri-apps/api/dialog";
import {listen} from "@tauri-apps/api/event";
import parse from "html-react-parser";

const GitCommand = {
    Status: "git_status",
    DiscardChanges: "git_discard_changes",
    Push: "git_push",
    Pull: "git_pull",
    Fetch: "git_fetch",
    GetPullPushCount: "get_pull_push_count",
    Commit: "git_commit",
    Log: "git_log",
    Diff: "git_diff",
    Branch: "git_branch",
    BranchCreate: "git_branch_create",
    BranchDelete: "git_branch_delete",
    BranchCheckout: "git_branch_checkout",
    BranchMerge: "git_branch_merge",
    CheckoutHash: "git_checkout_hash",
} as const;

enum ChangeState {
    Unknown,
    Change,
    Staging,
    Delete,
    Add,
}

enum BranchState {
    Unknown,
    Default,
    Current,
    Remote,
    All,
}

enum ViewMode {
    Commit,
    Log,
}

interface EmitMessage<T> {
    is_ok: boolean;
    result: T;
}

class StatusInfo {
    constructor() {
        this.change_state = ChangeState.Unknown;
        this.filename = '';
    }

    change_state: number;
    filename: string;
}

class PullPushCountInfo {
    constructor() {
        this.push_count = 0;
        this.pull_count = 0;
    }

    push_count: number;
    pull_count: number;
}

class ContextMenuInfo {
    constructor() {
        this.visible = false;
        this.x = 0;
        this.y = 0;
        this.statusInfo = {filename: '', change_state: ChangeState.Unknown};
    }

    visible: boolean;
    x: number;
    y: number;
    statusInfo: StatusInfo;
}

class ContextMenuInfo_branch {
    constructor() {
        this.visible = false;
        this.x = 0;
        this.y = 0;
        this.branchInfo = {branch_name: '', branch_state: BranchState.Unknown}
    }

    visible: boolean;
    x: number;
    y: number;
    branchInfo: BranchInfo;
}

class ContextMenuInfo_log {
    constructor() {
        this.visible = false;
        this.x = 0;
        this.y = 0;
        this.commitInfo = new CommitInfo();
    }

    visible: boolean;
    x: number;
    y: number;
    commitInfo: CommitInfo
}

class CommitInfo {
    constructor() {
        this.graph = '';
        this.hash = '';
        this.author = '';
        this.message = '';
        this.date = '';
        this.branch = '';
    }

    graph: string;
    hash: string;
    author: string;
    message: string;
    date: string;
    branch: string;
}

class BranchInfo {
    constructor() {
        this.branch_name = '';
        this.branch_state = BranchState.Unknown;
    }

    branch_name: string;
    branch_state: number;
}

let isInit: boolean = false;
let cancelCmds: string[] = [];
let cancelNoBlockCmds: string[] = [];
let g_currentLogViewBranch: BranchInfo = new BranchInfo();
let g_isShowFirstParentBranch: boolean = false;

function App() {
    const [version, setVersion] = useState<string>("");
    const [statusFiles, setStatusFiles] = useState<StatusInfo[]>([]);
    const [checkedFiles, setCheckedFiles] = useState<Set<string>>(new Set());
    const [isAllChecked, setIsAllChecked] = useState<boolean>(false);
    const [diffResult, setDiffResult] = useState("");
    const [selectedFile, setSelectedFile] = useState<StatusInfo[]>([]);
    const [lastClickedFile, setLastClickedFile] = useState<string>("");
    const [sideBySide, setSideBySide] = useState(false);
    const [commitMessage, setCommitMessage] = useState("");
    const [contextMenu, setContextMenu] = useState<ContextMenuInfo>(new ContextMenuInfo());
    const [contextMenu_branch, setContextMenu_branch] = useState<ContextMenuInfo_branch>(new ContextMenuInfo_branch());
    const [contextMenu_log, setContextMenu_log] = useState<ContextMenuInfo_log>(new ContextMenuInfo_log());
    const [pullPushCount, setPullPushCount] = useState<PullPushCountInfo>(new PullPushCountInfo());
    const [gitFolderPath, setGitFolderPath] = useState("");
    const [viewMode, setViewMode] = useState<ViewMode>();
    const [commits, setCommits] = useState<CommitInfo[]>([]);
    const [isVisibleoverlayCancelButton, setIsVisibleoverlayCancelButton] = useState(true);
    const [branches, setBranches] = useState<BranchInfo[]>([]);
    const [newBranchName, setNewBranchName] = useState("");
    const [currentLogViewBranch, setCurrentLogViewBranch] = useState<BranchInfo>(new BranchInfo());
    const [isShowFirstParentBranch, setIsShowFirstParentBranch] = useState(false);

    const [commitViewMiddleBarPosX, setCommitViewMiddleBarPosX] = useState<number>(300);
    const [graphColumnBarOnTreePanelPosX, setGraphColumnBarOnTreePanelPosX] = useState<number>(30);
    const [treeViewMiddleBarPosX, setTreeViewMiddleBarPosX] = useState<number>(220);

    const changeFilesScrollRef = useRef<HTMLDivElement>(null);
    const diffScrollRef = useRef<HTMLDivElement>(null);
    const diffScrollLeftRef = useRef<HTMLDivElement>(null);
    const diffScrollRightRef = useRef<HTMLDivElement>(null);

    const init = async () => {
        // コミットビューにしておく
        setViewMode(ViewMode.Commit);

        // 右クリックメニュー外をクリックした際に閉じる
        const handleClickOutside = () => hideContextMenu();
        window.addEventListener('click', handleClickOutside);
        const handleClickOutside_branch = () => hideContextMenu_branch();
        window.addEventListener('click', handleClickOutside_branch);
        const handleClickOutside_log = () => hideContextMenu_log();
        window.addEventListener('click', handleClickOutside_log);

        // ウィンドウフォーカスイベント
        // ※Windowsだとウィンドウ移動/リサイズを行った場合でもfocusイベントが通知される不具合がある 2024.6.21 (https://github.com/tauri-apps/tauri/issues/5864)
        const onFocus = async () => {
            await fetchStatus();
        };
        window.addEventListener('focus', onFocus);

        // git結果受信イベント
        const statusResultEvent = listen<EmitMessage<StatusInfo[]>>('post-git-status-result', (event) => {
            recieveStatusResult(event);
        });
        const pushResultEvent = listen<EmitMessage<string>>('post-git-push-result', (event) => {
            recievePushResult(event);
        });
        const pullResultEvent = listen<EmitMessage<string>>('post-git-pull-result', (event) => {
            recievePullResult(event);
        });
        const fetchResultEvent = listen<EmitMessage<string>>('post-git-fetch-result', (event) => {
            recieveFetchResult(event);
        });
        const getPullPushCountResultEvent = listen<EmitMessage<PullPushCountInfo>>('post-get-pull-push-count', (event) => {
            recievePullPushCountResult(event);
        });
        const diffResultEvent = listen<EmitMessage<string>>('post-git-diff-result', (event) => {
            recieveDiffResult(event);
        });
        const discardChangesAddsResultEvent = listen<EmitMessage<string>>('post-git-discard-changes-adds-result', (_) => {
            recieveDiscardChangesAddsResult();
        });
        const discardChangesOthersResultEvent = listen<EmitMessage<string>>('post-git-discard-changes-others-result', (_) => {
            recieveDiscardChangesOthersResult();
        });
        const commitResultEvent = listen<EmitMessage<string>>('post-git-commit-result', (event) => {
            recieveCommitResult(event);
        });
        const logResultEvent = listen<EmitMessage<CommitInfo[]>>('post-git-log-result', (event) => {
            recieveLogResult(event);
        });
        const branchResultEvent = listen<EmitMessage<BranchInfo[]>>('post-git-branch-result', (event) => {
            recieveBranchResult(event);
        });
        const branchCreateResultEvent = listen<EmitMessage<string>>('post-git-branch-create-result', (event) => {
            recieveBranchCreateResult(event);
        });
        const branchDeleteResultEvent = listen<EmitMessage<string>>('post-git-branch-delete-result', (event) => {
            recieveBranchDeleteResult(event);
        });
        const branchCheckoutResultEvent = listen<EmitMessage<string>>('post-git-branch-checkout-result', (event) => {
            recieveBranchCheckoutResult(event);
        });
        const branchMergeResultEvent = listen<EmitMessage<string>>('post-git-branch-merge-result', (event) => {
            recieveBranchMergeResult(event);
        });
        const checkoutHashResultEvent = listen<EmitMessage<string>>('post-git-checkout-hash-result', (event) => {
            recieveCheckoutHashResult(event);
        });

        await Promise.all([
            // バージョン情報取得
            fetchVersion(),
            // 現在開いているフォルダパスを取得
            getGitFolder(),
            // fetchしておく
            fetchStatus(),
            // current branch情報がほしいのでbranchも取得しておく
            gitBranch(),
        ]);

        isInit = true;

        return () => {
            window.removeEventListener('click', handleClickOutside);
            window.removeEventListener('click', handleClickOutside_branch);
            window.removeEventListener('click', handleClickOutside_log);
            window.removeEventListener('focus', onFocus);
            statusResultEvent.then(f => f());
            pushResultEvent.then(f => f());
            pullResultEvent.then(f => f());
            fetchResultEvent.then(f => f());
            getPullPushCountResultEvent.then(f => f());
            diffResultEvent.then(f => f());
            discardChangesAddsResultEvent.then(f => f());
            discardChangesOthersResultEvent.then(f => f());
            commitResultEvent.then(f => f());
            logResultEvent.then(f => f());
            branchResultEvent.then(f => f());
            branchCreateResultEvent.then(f => f());
            branchDeleteResultEvent.then(f => f());
            branchCheckoutResultEvent.then(f => f());
            branchMergeResultEvent.then(f => f());
            checkoutHashResultEvent.then(f => f());
        };
    }

    // 初回起動処理
    // (Debug実行時のみuseEffectが２度走るのはReactのStrictModeのせい. main.tsxの該当箇所をCOすれば１度のみとなる)
    useEffect(() => {
        init();
    }, []);

    const onChangeIsShowFirstParentBranch = async () => {
        await gitLogCancel();

        g_isShowFirstParentBranch = isShowFirstParentBranch; // なぜかuseStateだと値が保持されないため
        await gitLog();
    }

    useEffect(() => {
        if (!isInit) return; // オーバーレイが消えなくなるので起動時に走らないように。

        onChangeIsShowFirstParentBranch().then(_ => {
        });
    }, [isShowFirstParentBranch]);

    const onChangeCurrentLogViewBranch = async () => {
        await gitLogCancel();

        g_currentLogViewBranch = currentLogViewBranch; // なぜかuseStateだと値が保持されないため
        await gitLog();
    }

    useEffect(() => {
        if (!isInit) return; // オーバーレイが消えなくなるので起動時に走らないように。

        onChangeCurrentLogViewBranch().then(_ => {
        });
    }, [currentLogViewBranch]);

    // アプリのバージョン取得
    const fetchVersion = async () => {
        try {
            const version = await app.getVersion();
            setVersion(version);
        } catch (error) {
            console.error('Failed to get version:', error);
        }
    };

    // Fetch git status
    const fetchStatus = async () => {
        try {
            showNoBlockOverlay(GitCommand.Status);
            await invoke(GitCommand.Status, {windowLabel: getCurrent().label});
        } catch (error) {
            console.error("Failed to fetch git status:", error);
        }
    };

    const recieveStatusResult = async (event: event.Event<EmitMessage<StatusInfo[]>>) => {
        const result = event.payload;
        if (!result.is_ok) {
            console.error(result.result);
            return;
        }

        await getPullPushCount();

        // スクロール位置をTOPに
        if (changeFilesScrollRef.current) {
            changeFilesScrollRef.current.scrollTop = 0;
        }

        setStatusFiles(result.result);

        setLastClickedFile("");
        setDiffResult("");

        hideNoBlockOverlay(GitCommand.Status);
    }

    const getPullPushCount = async () => {
        try {
            showNoBlockOverlay(GitCommand.GetPullPushCount);
            await invoke(GitCommand.GetPullPushCount, {windowLabel: getCurrent().label});
        } catch (error) {
            console.error("Failed to get pull-push count:", error);
        }
    }

    const recievePullPushCountResult = async (event: event.Event<EmitMessage<PullPushCountInfo>>) => {
        const result = event.payload;
        if (!result.is_ok) {
            console.error(result.result);
            return;
        }

        setPullPushCount(result.result);

        hideNoBlockOverlay(GitCommand.GetPullPushCount);
    }

    const updateDiff = async (file: string) => {
        await gitDiffCancel();

        if (!file) return;
        await getDiff(file);
    };

    const gitDiffCancel = async () => {
        try {
            await invoke("git_diff_cancel", {windowLabel: getCurrent().label});
            hideNoBlockOverlay(GitCommand.Diff);
        } catch (error) {
            console.error("Failed to cancel:", error);
            alert("ERROR: Failed to cancel\n" + error);
        }
    };

    const getDiff = async (file: string) => {
        try {
            showNoBlockOverlay(GitCommand.Diff);
            await invoke(GitCommand.Diff, {windowLabel: getCurrent().label, file});
        } catch (error) {
            console.error("Failed to fetch git diff:", error);
        }
    };

    const recieveDiffResult = async (event: event.Event<EmitMessage<string>>) => {
        const result = event.payload;
        if (!result.is_ok) {
            console.error(result.result);
            return;
        }

        // スクロール位置をTOPに
        if (diffScrollRef.current) {
            diffScrollRef.current.scrollTop = 0;
        }

        let diff = result.result;
        if (diff) {
            setDiffResult(diff);
        } else {
            setDiffResult("");
        }

        hideNoBlockOverlay(GitCommand.Diff);
    }

    // Handle file click
    const handleFileClick = async (fileInfo: StatusInfo, event: React.MouseEvent) => {
        if (event.shiftKey && lastClickedFile) {
            const startIndex = statusFiles.findIndex(f => f.filename === lastClickedFile);
            const endIndex = statusFiles.findIndex(f => f.filename === fileInfo.filename);
            const range = statusFiles.slice(Math.min(startIndex, endIndex), Math.max(startIndex, endIndex) + 1);

            // 重複を取り除く
            // ( setSelectedFile(prev => Array.from(new Set([...prev, ...range]))); ウィンドウを再フォーカスした際にこれだと駄目だった )
            let newSelected = selectedFile;
            for (let info of range) {
                if (!selectedFile.some(v => v.filename === info.filename &&
                    v.change_state === info.change_state)) {
                    newSelected.push(info);
                }
            }
            setSelectedFile(newSelected);
        } else if (event.ctrlKey) {
            let newSelected = [...selectedFile];
            const isSelected = newSelected.some(v => v.filename === fileInfo.filename && v.change_state === fileInfo.change_state);
            if (isSelected) {
                newSelected = newSelected.filter(v => v.filename !== fileInfo.filename || v.change_state !== fileInfo.change_state);
            } else {
                newSelected.push(fileInfo);
            }
            setSelectedFile(newSelected);
        } else {
            setSelectedFile([fileInfo]);
        }

        setLastClickedFile(fileInfo.filename);
        await updateDiff(fileInfo.filename);
    };

    // Handle branch click
    const handleBranchClick = async (branchInfo: BranchInfo, _: React.MouseEvent) => {
        setCurrentLogViewBranch(branchInfo);
    };

    // Handle checkbox change
    const handleCheckboxChange = (filename: string) => {
        let targets: string[] = [];
        if (selectedFile.length > 1) {
            targets = selectedFile.map(v => v.filename);
        } else {
            targets.push(filename);
        }

        let newSet = new Set(checkedFiles);
        for (let filename of targets) {
            if (newSet.has(filename)) {
                newSet.delete(filename);
            } else {
                newSet.add(filename);
            }
        }

        setCheckedFiles(newSet);
    };

    // Handle for all checkbox change
    const handleAllCheckboxChange = () => {
        // flip the isAllChecked
        setIsAllChecked(!isAllChecked);

        // create a new set of files
        let allFiles = new Set<string>();
        statusFiles.forEach((file) => allFiles.add(file.filename));

        // conditionally set all files checked or unchecked
        if (!isAllChecked) setCheckedFiles(allFiles);
        else setCheckedFiles(new Set<string>());
    };

    // Handle commit
    const handleCommit = async () => {
        let currentBranch = branches.find(value => value.branch_state === BranchState.Current);
        if (currentBranch) {
            let isOnBranch = await invoke("is_on_branch", {
                branchName: currentBranch.branch_name,
                branchState: currentBranch.branch_state
            });

            if (!isOnBranch) {
                alert("特定のコミットハッシュにチェックアウトしている状態ではコミットできません。");
                return;
            }
        } else {
            console.warn("currentBranch is not found.");
        }

        const filesToCommit = Array.from(checkedFiles);
        if (filesToCommit.length === 0) {
            alert("コミットするファイルを選択してください。");
            return;
        }

        if (commitMessage.trim() === "") {
            const userResponse = await ask("コミットメッセージが空です。\n前回のコミットにまとめますか？");
            if (userResponse) {
                // Yesが選択された場合の処理
            } else {
                // Noが選択された場合の処理
                return;
            }
        }

        try {
            showOverlay(GitCommand.Commit, true);
            await invoke(GitCommand.Commit, {
                windowLabel: getCurrent().label,
                files: filesToCommit,
                message: commitMessage
            });
        } catch (error) {
            console.error("Failed to commit:", error);
            alert("ERROR: git commit\n" + error);
        }
    };

    const recieveCommitResult = async (event: event.Event<EmitMessage<string>>) => {
        const result = event.payload;
        if (!result.is_ok) {
            console.error(result.result);
            return;
        }

        refresh();

        await fetchStatus();

        hideOverlay(GitCommand.Commit);
    }

    const refresh = () => {
        setStatusFiles([]);
        setCheckedFiles(new Set());
        setCommitMessage("");
        setDiffResult("");
        setSelectedFile([]);
        setLastClickedFile("");
        setIsAllChecked(false);
    };

    // Get color for status
    const getColorForStatus = (changeState: ChangeState) => {
        switch (changeState) {
            case ChangeState.Change: // " M"
                return "#a9acb9";
            case ChangeState.Staging: // "M "
                return "#1E90FF";
            case ChangeState.Delete: // "D "
                return "#f44336";
            case ChangeState.Add: // "??"
                return "#009100";
            default: // others
                return "#dcac04";
        }
    };

    function ansiToHtml(ansiString: string) {
        const ansiRegex = /\x1b\[([0-9;]*)m/g;
        const stack: string[] = [];

        const ansiToHtmlMap: { [key: string]: string } = {
            '0': '</span>', // Reset
            '': '</span>', // Reset for \x1b[m
            '1': '<span style="font-weight:bold">', // Bold

            '30': '<span style="color:#353636">',
            '31': '<span style="color:#db5548">',
            '32': '<span style="color:#509c4e">',
            '33': '<span style="color:#bb7f0c">',
            '34': '<span style="color:#0881b6">',
            '35': '<span style="color:#a1299f">',
            '36': '<span style="color:#1493ad">',
            '37': '<span style="color:#b1a492">',

            '90': '<span style="color:#9e9282">',
            '91': '<span style="color:#f66042">',
            '92': '<span style="color:#bdbd33">',
            '93': '<span style="color:#f3c13e">',
            '94': '<span style="color:#8fada2">',
            '95': '<span style="color:#d495a5">',
            '96': '<span style="color:#98c88a">',
            '97': '<span style="color:#e5d9b9">',
        };

        return ansiString.replace(ansiRegex, (_, p1: string) => {
            const codes = p1.split(';');
            let html = '';

            codes.forEach(code => {
                if (code === '0' || code === '') {
                    while (stack.length > 0) {
                        html += stack.pop();
                    }
                } else {
                    const tag = ansiToHtmlMap[code];
                    if (tag) {
                        html += tag;
                        if (!tag.startsWith('</')) {
                            stack.push('</span>');
                        }
                    }
                }
            });

            return html;
        }) + stack.reverse().join('');
    }

    class LineWithStyle {
        constructor(public text: string, public style: React.CSSProperties) {
        }
    }

    // Render diff
    const renderDiff = (diff: string) => {
        if (!diff) return;

        if (sideBySide) {
            return renderSideBySideDiff(diff);
        } else {
            return renderUnifiedDiff(diff);
        }
    };

    const renderUnifiedDiff = (diff: string) => {
        if (!diff) return;

        const res: LineWithStyle[] = [];

        const lines = diff.split('\n');
        lines.forEach(line => {
            if (line.startsWith('-')) {
                const style = {color: '#f44336'};
                res.push(new LineWithStyle(`${line}`, style));
            } else if (line.startsWith('+')) {
                const style = {color: '#009100'};
                res.push(new LineWithStyle(`${line}`, style));
            } else if (line.startsWith('@')) {
                const style = {color: '#1E90FF'};
                res.push(new LineWithStyle(`${line}`, style));
            } else {
                if (!line) return;

                res.push(new LineWithStyle(`${line}`, {}));
            }
        });

        return (
            <div style={{display: 'flex'}}>
                <div style={{overflowX: 'auto', overflowY: 'hidden'}}>
                    {res.map((line, index) => (
                        <pre key={index} style={line.style}>{line.text}</pre>
                    ))}
                </div>
            </div>
        );
    };

    // Render side by side diff
    const renderSideBySideDiff = (diff: string) => {
        if (!diff) return;

        const lines = diff.split('\n');
        const leftLines: LineWithStyle[] = [];
        const rightLines: LineWithStyle[] = [];
        let leftLineNum = 0;
        let rightLineNum = 0;
        let maxLineNumLength = 0;

        // 最初に全行を見て、最大の行番号の桁数を計算する (表示用の行番号の桁数を合わせるため)
        lines.forEach(line => {
            if (line.startsWith('@@')) {
                const match = line.match(/@@ -(\d+),\d+ \+(\d+),\d+ @@/);
                if (match) {
                    const offsetLineNum = 3; // 変更差分の前後数行も差分表示対象のため (git diffのデフォルト設定だと前後3行？)
                    leftLineNum = parseInt(match[1] + offsetLineNum, 10);
                    rightLineNum = parseInt(match[2] + offsetLineNum, 10);
                    maxLineNumLength = Math.max(maxLineNumLength, leftLineNum.toString().length, rightLineNum.toString().length);
                }
            }
        });

        const getBlockSize = (startIndex: number, lines: string[]): [number, number] => {
            let left_size = 0;
            let right_size = 0;
            let i = startIndex;
            let maxCharacterNum = 0;

            while (i < lines.length && (lines[i].startsWith('-') || lines[i].startsWith('+'))) {
                if (lines[i].startsWith('-')) {
                    left_size++;
                }
                if (lines[i].startsWith('+')) {
                    right_size++;
                }

                maxCharacterNum = Math.max(lines[i].length, maxCharacterNum);
                i++;
            }

            return [Math.max(left_size, right_size), maxCharacterNum];
        };

        for (let index = 0; index < lines.length; index++) {
            let line = lines[index];

            if (line.startsWith('@@')) {
                const match = line.match(/@@ -(\d+),\d+ \+(\d+),\d+ @@/);
                if (match) {
                    leftLineNum = parseInt(match[1], 10);
                    rightLineNum = parseInt(match[2], 10);
                }

                const style = {color: '#1E90FF'};
                leftLines.push(new LineWithStyle(' ', style));
                leftLines.push(new LineWithStyle(`${line}`, style));
                rightLines.push(new LineWithStyle(' ', style));
                rightLines.push(new LineWithStyle(`${line}`, style));
            } else if (line.startsWith('diff --git') ||
                line.startsWith('index ') ||
                line.startsWith('--- ') ||
                line.startsWith('+++ ') ||
                line.startsWith('Binary ') ||
                line.startsWith('new file mode')
            ) {
                // 何もしない: 行をスキップ
            } else if (line.startsWith('-') || line.startsWith('+')) {
                let [block_size, maxCharacterNum] = getBlockSize(index, lines); // 差分行数が多い方の差分行数
                let skip_line_count = 0; // 処理済み行数
                let left_block_size = block_size; // 左側の未処理行数
                let right_block_size = block_size; // 右側の未処理行数

                let i = index;
                while (i < lines.length && (lines[i].startsWith('-') || lines[i].startsWith('+'))) {
                    if (lines[i].startsWith('-')) {
                        const style = {color: '#f44336'};
                        const str = `│ ${leftLineNum.toString().padStart(maxLineNumLength, ' ')} │ ${lines[i]}`;
                        const margin = maxLineNumLength + 5; // 行番号表示部分の文字数分オフセット
                        leftLines.push(new LineWithStyle(str.padEnd(maxCharacterNum + margin, ' '), style)); // 横スクロール幅を合わせるため右端を空白で埋める (2byte文字が入るとフォント幅の違いに寄り少しずれてしまうが現状は許容する)
                        leftLineNum++;
                        left_block_size--;
                    } else if (lines[i].startsWith('+')) {
                        const style = {color: '#009100'};
                        const str = `│ ${rightLineNum.toString().padStart(maxLineNumLength, ' ')} │ ${lines[i]}`;
                        const margin = maxLineNumLength + 5; // 行番号表示部分の文字数分オフセット
                        rightLines.push(new LineWithStyle(str.padEnd(maxCharacterNum + margin, ' '), style)); // 横スクロール幅を合わせるため右端を空白で埋める (2byte文字が入るとフォント幅の違いに寄り少しずれてしまうが現状は許容する)
                        rightLineNum++;
                        right_block_size--;
                    }

                    i++;
                    skip_line_count++;
                }

                // 空行挿入
                for (let i = 0; i < left_block_size; i++) {
                    leftLines.push(new LineWithStyle(`│ ${' '.repeat(maxLineNumLength)} │`, {}));
                }
                for (let i = 0; i < right_block_size; i++) {
                    rightLines.push(new LineWithStyle(`│ ${' '.repeat(maxLineNumLength)} │`, {}));
                }

                // 処理済みの行数分イテレーターを進める
                index += skip_line_count - 1;
            } else {
                if (!line) break;

                leftLines.push(new LineWithStyle(`│ ${leftLineNum.toString().padStart(maxLineNumLength, ' ')} │ ${line}`, {}));
                rightLines.push(new LineWithStyle(`│ ${rightLineNum.toString().padStart(maxLineNumLength, ' ')} │ ${line}`, {}));
                leftLineNum++;
                rightLineNum++;
            }
        }

        const handleScrollLeft = () => {
            if (diffScrollRightRef.current && diffScrollLeftRef.current) {
                diffScrollRightRef.current.scrollLeft = diffScrollLeftRef.current.scrollLeft
            }
        }
        const handleScrollRight = () => {
            if (diffScrollRightRef.current && diffScrollLeftRef.current) {
                diffScrollLeftRef.current.scrollLeft = diffScrollRightRef.current.scrollLeft
            }
        }

        return (
            <div style={{display: 'flex'}}>
                {/*left*/}
                <div
                    style={{width: '50%', overflowX: 'auto', overflowY: 'hidden'}}
                    ref={diffScrollLeftRef}
                    onScroll={handleScrollLeft}
                >
                    {leftLines.map((line, index) => (
                        <pre key={`left-${index}`} style={line.style}>
                        {line.text}
                    </pre>
                    ))}
                </div>

                {/* middle */}
                <div
                    className={"card shallow"}
                    style={{
                        margin: '0px 12px',
                        paddingLeft: '0px',
                        paddingRight: '0px',
                        backgroundColor: '#ddd',
                    }}
                />

                {/*right*/}
                <div
                    style={{width: '50%', overflowX: 'auto', overflowY: 'hidden'}}
                    ref={diffScrollRightRef}
                    onScroll={handleScrollRight}
                >
                    {rightLines.map((line, index) => (
                        <pre key={`right-${index}`} style={line.style}>
                        {line.text}
                    </pre>
                    ))}
                </div>
            </div>
        );
    };

    // Set initial X and panel width
    let initialX_CommitViewMiddleBar: number;
    let initialPanelWidth_CommitViewMiddleBar: number;
    // Mouse down event on the resizable bar
    const OnMouseDown_CommitViewMiddleBar = (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
        initialX_CommitViewMiddleBar = e.clientX;
        initialPanelWidth_CommitViewMiddleBar = commitViewMiddleBarPosX;
        document.addEventListener('mousemove', OnMouseMove_CommitViewMiddleBar);
        document.addEventListener('mouseup', OnMouseUp_CommitViewMiddleBar);
    };

    const OnMouseMove_CommitViewMiddleBar = (e: globalThis.MouseEvent) => {
        // Here, we calculate the new panel width based on the movement of the mouse.
        const newPanelWidth = initialPanelWidth_CommitViewMiddleBar + e.clientX - initialX_CommitViewMiddleBar;
        setCommitViewMiddleBarPosX(newPanelWidth);
    };

    const OnMouseUp_CommitViewMiddleBar = () => {
        document.removeEventListener('mousemove', OnMouseMove_CommitViewMiddleBar);
        document.removeEventListener('mouseup', OnMouseUp_CommitViewMiddleBar);
    };

    // Set initial X and panel width
    let initialX_GraphColumnBarOnTreePanel: number;
    let initialPanelWidth_GraphColumnBarOnTreePanel: number;
    const OnMouseDown_GraphColumnBarOnTreePanel = (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
        initialX_GraphColumnBarOnTreePanel = e.clientX;
        initialPanelWidth_GraphColumnBarOnTreePanel = graphColumnBarOnTreePanelPosX;
        document.addEventListener('mousemove', OnMouseMove_GraphColumnBarOnTreePanel);
        document.addEventListener('mouseup', OnMouseUp_GraphColumnBarOnTreePanel);
    };

    const OnMouseMove_GraphColumnBarOnTreePanel = (e: globalThis.MouseEvent) => {
        // Here, we calculate the new panel width based on the movement of the mouse.
        const newPanelWidth = initialPanelWidth_GraphColumnBarOnTreePanel + e.clientX - initialX_GraphColumnBarOnTreePanel;
        setGraphColumnBarOnTreePanelPosX(newPanelWidth);
    };

    const OnMouseUp_GraphColumnBarOnTreePanel = () => {
        document.removeEventListener('mousemove', OnMouseMove_GraphColumnBarOnTreePanel);
        document.removeEventListener('mouseup', OnMouseUp_GraphColumnBarOnTreePanel);
    };

    // Set initial X and panel width
    let initialX_TreeViewMiddleBar: number;
    let initialPanelWidth_TreeViewMiddleBar: number;
    // Mouse down event on the resizable bar
    const OnMouseDown_TreeViewMiddleBar = (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
        initialX_TreeViewMiddleBar = e.clientX;
        initialPanelWidth_TreeViewMiddleBar = treeViewMiddleBarPosX;
        document.addEventListener('mousemove', OnMouseMove_TreeViewMiddleBar);
        document.addEventListener('mouseup', OnMouseUp_TreeViewMiddleBar);
    };

    const OnMouseMove_TreeViewMiddleBar = (e: globalThis.MouseEvent) => {
        // Here, we calculate the new panel width based on the movement of the mouse.
        const newPanelWidth = initialPanelWidth_TreeViewMiddleBar + e.clientX - initialX_TreeViewMiddleBar;
        setTreeViewMiddleBarPosX(newPanelWidth);
    };

    const OnMouseUp_TreeViewMiddleBar = () => {
        document.removeEventListener('mousemove', OnMouseMove_TreeViewMiddleBar);
        document.removeEventListener('mouseup', OnMouseUp_TreeViewMiddleBar);
    };

    // --- 右クリックメニュー
    const handleContextMenu = (event: React.MouseEvent<HTMLLIElement, MouseEvent>, statusInfo: StatusInfo) => {
        event.preventDefault();
        if (event.ctrlKey) return; // ctrlを押しながらクリックするとonContextMenuが呼び出されてしまうので

        setContextMenu({visible: true, x: event.clientX, y: event.clientY, statusInfo});
    }

    // コンテキストメニューを隠す関数
    const hideContextMenu = () => {
        setContextMenu({
            visible: false,
            x: 0,
            y: 0,
            statusInfo: {filename: '', change_state: ChangeState.Unknown}
        });
    };

    const handleContextMenu_branch = (event: React.MouseEvent<HTMLLIElement, MouseEvent>, branchInfo: BranchInfo) => {
        if (branchInfo.branch_state === BranchState.Current) return;

        event.preventDefault();
        if (event.ctrlKey) return; // ctrlを押しながらクリックするとonContextMenuが呼び出されてしまうので

        setContextMenu_branch({visible: true, x: event.clientX, y: event.clientY, branchInfo: branchInfo});
    }

    const hideContextMenu_branch = () => {
        setContextMenu_branch({
            visible: false,
            x: 0,
            y: 0,
            branchInfo: {branch_name: '', branch_state: BranchState.Unknown}
        });
    };

    const handleContextMenu_log = (event: React.MouseEvent<HTMLPreElement, MouseEvent>, commitInfo: CommitInfo) => {
        event.preventDefault();
        if (event.ctrlKey) return; // ctrlを押しながらクリックするとonContextMenuが呼び出されてしまうので

        setContextMenu_log({visible: true, x: event.clientX, y: event.clientY, commitInfo: commitInfo});
    }

    const hideContextMenu_log = () => {
        setContextMenu_log({
            visible: false,
            x: 0,
            y: 0,
            commitInfo: new CommitInfo(),
        });
    };

    // 変更を破棄する関数
    const discardChanges = async () => {
        try {
            let infos = selectedFile;

            let files = infos.map(v => v.filename).sort().join("\n");
            const userResponse = await ask(files, '変更を破棄しますか？');

            if (userResponse) {
                // Yesが選択された場合の処理

                hideContextMenu();
                showOverlay(GitCommand.DiscardChanges, true);
                await invoke(GitCommand.DiscardChanges, {windowLabel: getCurrent().label, infos: infos});
            } else {
                // Noが選択された場合の処理
            }
        } catch (error) {
            console.error("Failed to discard changes:", error);
        }
    };

    let isRecieveDiscardChangesAddsResult = false;
    let isRecieveDiscardChangesOthersResult = false;

    const recieveDiscardChangesAddsResult = async () => {
        isRecieveDiscardChangesAddsResult = true;

        if (isRecieveDiscardChangesAddsResult && isRecieveDiscardChangesOthersResult) {
            isRecieveDiscardChangesAddsResult = false;
            isRecieveDiscardChangesOthersResult = false;
            await recieveDiscardChangesResult();
        }
    }
    const recieveDiscardChangesOthersResult = async () => {
        isRecieveDiscardChangesOthersResult = true;

        if (isRecieveDiscardChangesAddsResult && isRecieveDiscardChangesOthersResult) {
            isRecieveDiscardChangesAddsResult = false;
            isRecieveDiscardChangesOthersResult = false;
            await recieveDiscardChangesResult();
        }
    }
    const recieveDiscardChangesResult = async () => {
        refresh();
        await fetchStatus();
        hideOverlay(GitCommand.DiscardChanges);
    }

    // ファイルの場所を開く関数
    const openFileLocation = async (filename: string) => {
        try {
            hideContextMenu();
            await invoke("open_file_location", {file: filename});
        } catch (error) {
            console.error("Failed to open file location:", error);
        }
    };

    const gitPush = async () => {
        try {
            showOverlay(GitCommand.Push, true);
            await invoke(GitCommand.Push, {windowLabel: getCurrent().label});
        } catch (error) {
            console.error("Failed to push:", error);
            alert("ERROR: git push\n" + error);
        }
    };

    const recievePushResult = async (event: event.Event<EmitMessage<string>>) => {
        const result = event.payload;
        if (!result.is_ok) {
            alert(result.result);
            return;
        }

        await getPullPushCount();

        hideOverlay(GitCommand.Push);
        alert(result.result);
    }

    const gitPull = async () => {
        try {
            showOverlay(GitCommand.Pull, true);
            await invoke(GitCommand.Pull, {windowLabel: getCurrent().label});
        } catch (error) {
            console.error("Failed to pull:", error);
            alert("ERROR: git pull\n" + error);
        }
    };

    const recievePullResult = async (event: event.Event<EmitMessage<string>>) => {
        const result = event.payload;
        if (!result.is_ok) {
            alert(result.result);
            return;
        }

        await fetchStatus();
        setViewMode(ViewMode.Commit);

        hideOverlay(GitCommand.Pull);
        alert(result.result);
    }

    const gitFetch = async () => {
        try {
            showOverlay(GitCommand.Fetch, true);
            await invoke(GitCommand.Fetch, {windowLabel: getCurrent().label});
        } catch (error) {
            console.error("Failed to pull:", error);
            alert("ERROR: git pull\n" + error);
        }
    };

    const recieveFetchResult = async (event: event.Event<EmitMessage<string>>) => {
        const result = event.payload;
        if (!result.is_ok) {
            alert(result.result);
            return;
        }

        setViewMode(ViewMode.Commit);
        await getPullPushCount();

        hideOverlay(GitCommand.Fetch);
    }

    const selectGitFolder = async () => {
        try {
            const path = await invoke<string>("select_git_folder");
            setGitFolderPath(path);
            setViewMode(ViewMode.Commit);

            refresh();

            await Promise.all([
                fetchStatus(),
                gitBranch(), // current branch情報がほしいのでbranchも取得しておく
            ]);
        } catch (error) {
            console.error("Failed to select git folder:", error);
        }
    };

    const getGitFolder = async () => {
        try {
            const path = await invoke<string>("get_git_folder");
            setGitFolderPath(path);
        } catch (error) {
            console.error("Failed to get git folder:", error);
        }
    };

    const gitLog = async () => {
        try {
            showNoBlockOverlay(GitCommand.Log);

            let isOnBranch = await invoke("is_on_branch", {
                branchName: g_currentLogViewBranch.branch_name,
                branchState: g_currentLogViewBranch.branch_state
            });

            let branchName = isOnBranch ?
                g_currentLogViewBranch.branch_name :
                ""; // 特定のコミットハッシュにチェックアウトしている場合

            await invoke(GitCommand.Log, {
                windowLabel: getCurrent().label,
                isShowAll: g_currentLogViewBranch.branch_state === BranchState.All,
                branchName: branchName,
                isFirstParent: g_isShowFirstParentBranch,
            });
        } catch (error) {
            console.error("Failed to git log:", error);
        }
    };

    const gitLogCancel = async () => {
        try {
            await invoke("git_log_cancel", {windowLabel: getCurrent().label});
            hideNoBlockOverlay(GitCommand.Log);
        } catch (error) {
            console.error("Failed to cancel:", error);
            alert("ERROR: Failed to cancel\n" + error);
        }
    };

    const recieveLogResult = async (event: event.Event<EmitMessage<CommitInfo[]>>) => {
        const result = event.payload;
        if (!result.is_ok) {
            console.error(result.result);
            return;
        }

        setCommits(result.result);

        hideNoBlockOverlay(GitCommand.Log);
    }

    const gitBranch = async () => {
        try {
            showNoBlockOverlay(GitCommand.Branch);
            await invoke(GitCommand.Branch, {windowLabel: getCurrent().label});
        } catch (error) {
            console.error("Failed to git branch:", error);
        }
    };

    const recieveBranchResult = async (event: event.Event<EmitMessage<BranchInfo[]>>) => {
        const result = event.payload;
        if (!result.is_ok) {
            console.error(result.result);
            return;
        }

        setBranches(result.result);
        setCurrentLogViewBranch(result.result.find(value => value.branch_state === BranchState.Current) ?? new BranchInfo());

        hideNoBlockOverlay(GitCommand.Branch);
    }

    // 改行禁止 (Enterキーが押されたときにイベントを無視)
    const prohibitNewLineOnKeyPress = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter') {
            event.preventDefault();
        }
    };

    // 改行禁止 (ペースト操作で改行が含まれる場合に除去)
    const prohibitNewLineOnPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
        event.preventDefault();
        const pastedText = event.clipboardData.getData('text');
        const sanitizedText = pastedText.replace(/[\r\n\v]+/g, "");
        const newValue = newBranchName + sanitizedText;
        setNewBranchName(newValue);
    };

    const gitBranchCreate = async () => {
        if (!newBranchName) {
            alert("作成するブランチ名を入力してください");
            return;
        }

        try {
            showOverlay(GitCommand.BranchCreate, true);
            await invoke(GitCommand.BranchCreate, {windowLabel: getCurrent().label, newBranchName: newBranchName});
        } catch (error) {
            console.error("Failed to git branch create:", error);
        }
    };

    const recieveBranchCreateResult = async (event: event.Event<EmitMessage<string>>) => {
        const result = event.payload;
        if (!result.is_ok) {
            alert(result.result);
            return;
        }

        if (result.result) {
            alert(result.result);
        } else {
            setNewBranchName("");
        }

        await Promise.all([
            gitBranch(),
            gitLog(),
            getPullPushCount(),
        ])

        hideOverlay(GitCommand.BranchCreate);
    }

    const gitBranchDelete = async (branchName: string) => {
        try {
            showOverlay(GitCommand.BranchDelete, true);
            await invoke(GitCommand.BranchDelete, {
                windowLabel: getCurrent().label,
                deleteBranchName: branchName,
            });
        } catch (error) {
            console.error("Failed to git branch delete:", error);
        }
    };

    const recieveBranchDeleteResult = async (event: event.Event<EmitMessage<string>>) => {
        const result = event.payload;
        if (!result.is_ok) {
            alert(result.result);
            return;
        }

        if (result.result) {
            alert(result.result);
        }

        await Promise.all([
            gitBranch(),
            gitLog(),
        ])

        hideOverlay(GitCommand.BranchDelete);
    }

    const gitBranchCheckout = async (branchName: string) => {
        let localBranchName = branchName.replace(/^remotes\/origin\//, '');

        try {
            showOverlay(GitCommand.BranchCheckout, true);
            await invoke(GitCommand.BranchCheckout, {
                windowLabel: getCurrent().label,
                checkoutBranchName: localBranchName,
            });
        } catch (error) {
            console.error("Failed to git branch checkout:", error);
        }
    };

    const recieveBranchCheckoutResult = async (event: event.Event<EmitMessage<string>>) => {
        const result = event.payload;
        if (!result.is_ok) {
            alert(result.result);
            return;
        }

        if (result.result) {
            alert(result.result);
        }

        await Promise.all([
            gitBranch(),
            gitLog(),
            getPullPushCount(),
        ])

        hideOverlay(GitCommand.BranchCheckout);
    }

    const gitBranchMerge = async (branchName: string) => {
        try {
            showOverlay(GitCommand.BranchMerge, true);
            await invoke(GitCommand.BranchMerge, {
                windowLabel: getCurrent().label,
                mergeBranchName: branchName,
            });
        } catch (error) {
            console.error("Failed to git branch merge:", error);
        }
    };

    const recieveBranchMergeResult = async (event: event.Event<EmitMessage<string>>) => {
        const result = event.payload;
        if (!result.is_ok) {
            alert(result.result);
            return;
        }

        if (result.result) {
            alert(result.result);
        }

        await Promise.all([
            gitBranch(),
            gitLog(),
            getPullPushCount(),
        ])

        hideOverlay(GitCommand.BranchMerge);
    }

    const gitCheckoutHash = async (commitHash: string) => {
        try {
            showOverlay(GitCommand.CheckoutHash, true);
            await invoke(GitCommand.CheckoutHash, {
                windowLabel: getCurrent().label,
                commitHash: commitHash,
            });
        } catch (error) {
            console.error("Failed to git checkout hash:", error);
        }
    };

    const recieveCheckoutHashResult = async (event: event.Event<EmitMessage<string>>) => {
        const result = event.payload;
        if (!result.is_ok) {
            alert(result.result);
            return;
        }

        if (result.result) {
            alert(result.result);
        }

        await Promise.all([
            gitBranch(),
            gitLog(),
            getPullPushCount(),
        ])

        hideOverlay(GitCommand.CheckoutHash);
    }

    const minimize = () => {
        appWindow.minimize();
    };

    const maximize = () => {
        appWindow.toggleMaximize();
    };

    const closeWindow = () => {
        appWindow.close();
    };

    const getMainPanel = () => {
        switch (viewMode) {
            case ViewMode.Commit:
                return getCommitPanel();
            case ViewMode.Log:
                return (
                    <div style={{display: 'flex', overflow: 'auto', flex: 1}}>
                        {getBranchPanel()}

                        {/* middle handle */}
                        <div
                            className={"card shallow-inset"}
                            style={{
                                margin: '15px 0px 8px 0px',
                                padding: '22px 1px 22px 1px',
                                backgroundColor: '#ddd',
                                cursor: 'col-resize',
                            }}
                            onMouseDown={OnMouseDown_TreeViewMiddleBar}
                        />

                        {getTreePanel()}
                    </div>
                )
        }
    }

    const onChangeViewMode = async (mode: ViewMode) => {
        switch (mode) {
            case ViewMode.Commit:
                break;
            case ViewMode.Log:
                await Promise.all([
                    gitLog(),
                    gitBranch(),
                ]);
                break;
        }

        setViewMode(mode);
    }

    const openNewWindow = async (hash: string, x: number, y: number) => {
        try {
            // 現在のウィンドウの位置を取得
            const windowPosition = await appWindow.outerPosition();
            const absoluteX = windowPosition.x + x;
            const absoluteY = windowPosition.y + y;
            await invoke('open_new_window', {hash: hash, x: absoluteX, y: absoluteY});
        } catch (error) {
            console.error("Failed to openNewWindow:", error);
        }
    }

    const allGitCommandCancel = async () => {
        try {
            for (const v of cancelCmds) {
                await invoke(v + "_cancel", {windowLabel: getCurrent().label});
                hideOverlay(v);
            }
        } catch (error) {
            console.error("Failed to cancel:", error);
            alert("ERROR: Failed to cancel\n" + error);
        }
    };

    const showOverlay = (cmd: string, isVisibleCancelButton: boolean) => {
        cancelCmds.push(cmd);
        setIsVisibleoverlayCancelButton(isVisibleCancelButton);

        let overlay = document.getElementById('overlay');
        if (overlay) {
            overlay.style.display = 'block';
        }
    }
    const hideOverlay = (cmd: string) => {
        cancelCmds = cancelCmds.filter(v => v !== cmd);

        if (cancelCmds.length > 0) return;

        let overlay = document.getElementById('overlay');
        if (overlay) {
            overlay.style.display = 'none';
        }
    }

    const showNoBlockOverlay = (cmd: string) => {
        cancelNoBlockCmds.push(cmd);

        let overlay = document.getElementById('overlay-no-block-panel');
        if (overlay) {
            overlay.style.display = 'block';
        }
    }
    const hideNoBlockOverlay = (cmd: string) => {
        cancelNoBlockCmds = cancelNoBlockCmds.filter(v => v !== cmd);

        if (cancelNoBlockCmds.length > 0) return;

        let overlay = document.getElementById('overlay-no-block-panel');
        if (overlay) {
            overlay.style.display = 'none';
        }
    }

    const getFileNameWithChangeState = (info: StatusInfo) => {
        let res = info.filename;
        switch (info.change_state) {
            case ChangeState.Unknown:
                break;
            case ChangeState.Change:
                res = "M : " + res;
                break;
            case ChangeState.Staging:
                break;
            case ChangeState.Delete:
                res = "D : " + res;
                break;
            case ChangeState.Add:
                res = "A : " + res;
                break;
        }
        return res;
    }

    const getBranchNameViewStr = (branchInfo: BranchInfo) => {
        let res = branchInfo.branch_name;

        if (branchInfo.branch_state === BranchState.Current) {
            res = res + " ← HEAD"
        }

        return res;
    }

    const getCommitPanel = () => {
        return (
            <div style={{display: 'flex', flex: 1, overflow: 'hidden'}}>

                {/* left panel */}
                <div className={"card middle"} style={{
                    width: commitViewMiddleBarPosX,
                    display: 'flex',
                    flexDirection: 'column',
                    margin: '15px 10px 8px 20px',
                    rowGap: '10px'
                }}>
                    <div style={{display: 'flex'}}>
                        <button onClick={handleAllCheckboxChange}>
                            {isAllChecked ? 'Unselect all' : 'Select all'}
                        </button>
                    </div>
                    <div style={{flex: 1, overflowY: 'auto'}}
                         ref={changeFilesScrollRef}>
                        <ul style={{paddingLeft: '0px', margin: '0', width: 'fit-content'}}>
                            {statusFiles.map((fileInfo, index) => (
                                <div
                                    key={index}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        backgroundColor: selectedFile.some(f => f.filename === fileInfo.filename) ? '#ddd' : 'transparent',
                                        borderRadius: '5px',
                                    }}
                                >
                                    <label className={"checkbox-container"}>
                                        <input
                                            type="checkbox"
                                            checked={checkedFiles.has(fileInfo.filename)}
                                            onChange={() => handleCheckboxChange(fileInfo.filename)}
                                        />
                                        <div className={"checkmark"}></div>
                                    </label>
                                    <li
                                        onClick={(event) => handleFileClick(fileInfo, event)}
                                        onContextMenu={(event) => handleContextMenu(event, fileInfo)}
                                        style={{
                                            color: getColorForStatus(fileInfo.change_state),
                                            textDecoration: fileInfo.change_state === ChangeState.Delete ? 'line-through' : 'none',
                                            listStyleType: 'none',
                                            padding: '10px',
                                            flex: '1',
                                        }}>
                                        {getFileNameWithChangeState(fileInfo)}
                                    </li>
                                </div>
                            ))}
                        </ul>
                    </div>
                    <div style={{
                        display: 'flex',
                        padding: '10px',
                        borderTop: '1px solid #ddd',
                        columnGap: '10px'
                    }}>
                        <textarea
                            placeholder="Commit message"
                            value={commitMessage}
                            onChange={(e) => setCommitMessage(e.target.value)}
                            style={{flex: 1}}
                        />
                        <button onClick={handleCommit} style={{marginLeft: '10px'}}>
                            Commit
                        </button>
                    </div>
                </div>

                {/* middle handle */}
                <div
                    className={"card shallow-inset"}
                    style={{
                        margin: '15px 0px 8px 0px',
                        padding: '22px 1px 22px 1px',
                        backgroundColor: '#ddd',
                        cursor: 'col-resize',
                    }}
                    onMouseDown={OnMouseDown_CommitViewMiddleBar}
                />

                {/* right panel*/}
                <div className={"card middle"}
                     style={{
                         width: `calc(100% - ${commitViewMiddleBarPosX}px)`,
                         display: 'flex',
                         margin: '15px 20px 8px 10px',
                         flexDirection: 'column',
                         overflow: 'hidden',
                     }}
                >
                    <div style={{padding: '0px 0px 3px 7px'}}>
                        <label className="toggle-container">
                            <div style={{paddingRight: '5px'}}>
                                Unified
                            </div>
                            <div className="toggle">
                                <input
                                    className="toggle-state"
                                    type="checkbox" name="check"
                                    value="check"
                                    checked={sideBySide}
                                    onChange={(e) => setSideBySide(e.target.checked)}
                                />
                                <div className="indicator"></div>
                            </div>
                            <div style={{paddingLeft: '5px'}}>
                                Side by side
                            </div>
                        </label>
                    </div>

                    <div className={"card shallow-inset"}
                         ref={diffScrollRef}
                         style={{
                             overflowY: 'auto',
                             flex: 1,
                             padding: '0px 18px 0px 18px',
                             userSelect: 'text', // テキスト選択を有効に
                             WebkitUserSelect: 'text', // テキスト選択を有効 forMac (参考: https://github.com/tauri-apps/tauri/issues/5016)
                             cursor: 'auto', // テキスト上ではカーソルを変更する
                             margin: '0',
                             flexDirection: 'column',
                         }}
                    >
                        {renderDiff(diffResult)}
                    </div>
                </div>
            </div>
        );
    }

    const getTreePanel = () => {
        return (
            <div style={{
                width: `calc(100% - ${treeViewMiddleBarPosX}px)`,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'auto',
                flex: 1
            }}>
                <div style={{padding: '10px 0px 0px 30px'}}>
                    <label className="toggle-container">
                        <div style={{paddingRight: '5px'}}>Normal</div>
                        <div className="toggle">
                            <input
                                className="toggle-state"
                                type="checkbox"
                                name="check"
                                value="check"
                                checked={isShowFirstParentBranch}
                                onChange={(e) => setIsShowFirstParentBranch(e.target.checked)}
                            />
                            <div className="indicator"></div>
                        </div>
                        <div style={{paddingLeft: '5px'}}>Only logs for this branch</div>
                    </label>
                </div>
                <div
                    className={"card shallow-inset"}
                    style={{
                        overflowY: 'auto',
                        flex: 1,
                        padding: '0px 18px',
                        margin: '0px 15px 15px 15px',
                        flexDirection: 'column',
                    }}
                >
                    <div style={{display: 'flex'}}>
                        {/*graph*/}
                        <div style={{overflowX: 'auto', overflowY: 'hidden', width: graphColumnBarOnTreePanelPosX}}>
                            {commits.map((v, index) => (
                                <pre key={`graph-${index}`} style={{height: '10px'}}>
                                {parse(ansiToHtml(v.graph))}
                            </pre>
                            ))}
                        </div>

                        {/* middle handle */}
                        <div
                            className={"card shallow-inset"}
                            style={{
                                margin: '0px 10px',
                                padding: '22px 1px',
                                backgroundColor: '#ddd',
                                cursor: 'col-resize',
                            }}
                            onMouseDown={OnMouseDown_GraphColumnBarOnTreePanel}
                        />

                        {/*hash*/}
                        <div style={{overflowX: 'auto', overflowY: 'hidden'}}>
                            {commits.map((v, index) => (
                                <pre key={`hash-${index}`} style={{height: '10px'}}>
                                {v.hash ? (
                                    <button
                                        className={"button-shallow"}
                                        onClick={(e) => openNewWindow(v.hash, e.clientX, e.clientY)}
                                        style={{margin: '0px 7px', padding: '0px 6px'}}
                                    >
                                        {v.hash}
                                    </button>
                                ) : (
                                    <div/>
                                )}
                            </pre>
                            ))}
                        </div>

                        {/* --- */}
                        <div
                            className={"card shallow-inset"}
                            style={{
                                margin: '0px 10px',
                                paddingLeft: '0px',
                                paddingRight: '0px',
                                backgroundColor: '#ddd',
                            }}
                        />

                        {/*date*/}
                        <div style={{overflowX: 'auto', overflowY: 'hidden'}}>
                            {commits.map((v, index) => (
                                <pre key={`date-${index}`}
                                     onContextMenu={(event) => handleContextMenu_log(event, v)}
                                     style={{height: '10px'}}>
                                    {v.date}
                                </pre>
                            ))}
                        </div>

                        {/* --- */}
                        <div
                            className={"card shallow-inset"}
                            style={{
                                margin: '0px 10px',
                                paddingLeft: '0px',
                                paddingRight: '0px',
                                backgroundColor: '#ddd',
                            }}
                        />

                        {/*message*/}
                        <div style={{
                            flex: 1,
                            overflowX: 'auto',
                            overflowY: 'hidden',
                            userSelect: 'text', // テキスト選択を有効に
                            WebkitUserSelect: 'text', // テキスト選択を無効forMac (参考: https://github.com/tauri-apps/tauri/issues/5016)
                            cursor: 'auto', // テキスト上ではカーソルを変更する
                        }}>
                            {commits.map((v, index) => (
                                <pre key={`message-${index}`}
                                     onContextMenu={(event) => handleContextMenu_log(event, v)}
                                     style={{height: '10px'}}>
                                {<p>{parse(ansiToHtml(v.branch))} {v.message}</p>}
                            </pre>
                            ))}
                        </div>

                        {/* --- */}
                        <div
                            className={"card shallow-inset"}
                            style={{
                                margin: '0px 10px',
                                paddingLeft: '0px',
                                paddingRight: '0px',
                                backgroundColor: '#ddd',
                            }}
                        />

                        {/*author*/}
                        <div style={{overflowX: 'auto', overflowY: 'hidden'}}>
                            {commits.map((v, index) => (
                                <pre key={`author-${index}`}
                                     onContextMenu={(event) => handleContextMenu_log(event, v)}
                                     style={{height: '10px'}}>
                                    {v.author}
                                </pre>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    const getBranchPanel = () => {
        return (
            <div className={"card middle"} style={{
                width: treeViewMiddleBarPosX,
                display: 'flex',
                flexDirection: 'column',
                margin: '15px 10px 8px 20px',
                rowGap: '10px',
            }}>
                <div style={{flex: 1, overflowY: 'auto'}}>
                    <ul style={{paddingLeft: '0px', margin: '0'}}>
                        {/* Allブランチ */}
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                borderRadius: '5px'
                            }}
                        >
                            <li
                                className={"hover-shallow-inset-box"}
                                onClick={(event) => handleBranchClick({
                                    branch_name: "[All]",
                                    branch_state: BranchState.All
                                }, event)}
                                style={{
                                    display: 'flex',
                                    listStyleType: 'none',
                                    padding: '10px',
                                    flex: '1',
                                    alignItems: 'center',
                                }}>
                                {
                                    currentLogViewBranch.branch_name === "[All]" ?
                                        (
                                            <img src="/eye.svg" alt="" style={{
                                                width: '15px',
                                                height: '15px',
                                                marginRight: '7px',
                                            }}/>
                                        ) : (<div/>)
                                }
                                <div>
                                    {getBranchNameViewStr({branch_name: "[All]", branch_state: BranchState.All})}
                                </div>
                            </li>
                        </div>
                        {/* 全ブランチ */}
                        {branches.map((v, index) => (
                            <div
                                key={index}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    borderRadius: '5px'
                                }}
                            >
                                <li
                                    className={"hover-shallow-inset-box"}
                                    onClick={(event) => handleBranchClick(v, event)}
                                    onContextMenu={(event) => handleContextMenu_branch(event, v)}
                                    style={{
                                        display: 'flex',
                                        color: v.branch_state === BranchState.Current ? '#1493ad' : '',
                                        fontWeight: v.branch_state === BranchState.Current ? 'bold' : 'normal',
                                        listStyleType: 'none',
                                        padding: '10px',
                                        flex: '1',
                                        alignItems: 'center',
                                    }}>
                                    {
                                        currentLogViewBranch.branch_name === v.branch_name ?
                                            (
                                                <img src="/eye.svg" alt="" style={{
                                                    width: '15px',
                                                    height: '15px',
                                                    marginRight: '7px',
                                                }}/>
                                            ) : (<div/>)
                                    }
                                    <div>
                                        {getBranchNameViewStr(v)}
                                    </div>
                                </li>
                            </div>
                        ))}
                    </ul>
                </div>
                <div style={{
                    display: 'flex',
                    padding: '10px',
                    borderTop: '1px solid #ddd',
                    columnGap: '10px',
                    height: '40px'
                }}>
                        <textarea
                            placeholder="New branch name"
                            value={newBranchName}
                            onKeyPress={prohibitNewLineOnKeyPress}
                            onPaste={prohibitNewLineOnPaste}
                            onChange={(e) => setNewBranchName(e.target.value)}
                            style={{flex: 1}}
                        />
                    <button
                        onClick={gitBranchCreate}
                    >
                        Create
                    </button>
                </div>
            </div>
        );
    }


    // -------------------------- return --------------------------
    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100vh',
        }}>
            <div className="card middle"
                 style={{
                     margin: '0',
                     borderRadius: '0',
                     padding: '0px 0px 6px 0px',
                     flexDirection: 'column',
                     backgroundColor: '#EBECF0',
                     zIndex: '9999'
                 }}>
                <div data-tauri-drag-region className="titlebar" style={{width: '100%'}}>
                    <div data-tauri-drag-region className="title" style={{padding: '8px 0px 0px  20px'}}>ZenGit</div>
                    <div data-tauri-drag-region style={{padding: '10px 0px 0px  20px'}}>
                        {gitFolderPath}
                    </div>
                    <div style={{display: 'flex'}}>
                        <button className="button" style={{margin: '2px'}} onClick={minimize}>_</button>
                        <button className="button" style={{margin: '2px'}} onClick={maximize}>[]</button>
                        <button className="button" style={{margin: '2px'}} onClick={closeWindow}>X</button>
                    </div>
                </div>
            </div>
            <div style={{
                display: 'flex',
                padding: '15px 20px 0px',
                columnGap: '20px',
                alignItems: 'center'
            }}>
                <button onClick={selectGitFolder} style={{minHeight: '40px', minWidth: '50px'}}>
                    Open
                </button>
                <button onClick={gitFetch} style={{minHeight: '40px', minWidth: '50px'}}>
                    Fetch
                </button>
                <button onClick={gitPull} style={{minHeight: '40px', minWidth: '80px'}}>
                    Pull {pullPushCount.pull_count > 0 ? "⇣" + pullPushCount.pull_count : ''}
                    {/*Pull {"⇣1234"}*/}
                </button>
                <button onClick={gitPush} style={{minHeight: '40px', minWidth: '80px'}}>
                    Push {pullPushCount.push_count > 0 ? "⇡" + pullPushCount.push_count : ''}
                    {/*Push {"⇣1234"}*/}
                </button>
                <div style={{display: 'flex', justifyContent: 'flex-end', flex: '1'}}>
                    <Tabs selectedIndex={viewMode}
                          onSelect={(index) => {
                              onChangeViewMode(index as ViewMode);
                          }}>
                        <TabList style={{margin: '0'}}>
                            <div style={{margin: '0px 0px 6px 10px'}}>
                                mode
                            </div>
                            <Tab>Commit</Tab>
                            <Tab>Log</Tab>
                        </TabList>
                    </Tabs>
                </div>
            </div>

            {/*main pannel*/}
            {getMainPanel()}
            <div style={{display: 'flex', margin: '0px 10px 5px auto', fontSize: '8px'}}>
                ver {version}
            </div>


            {/*オーバーレイ*/}
            <div id={"overlay"}>
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                }}>
                    <div style={{
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%,-50%)'
                    }}>
                        <div className={"dot-spinner"}>
                            <div className={"dot-spinner__dot"}></div>
                            <div className={"dot-spinner__dot"}></div>
                            <div className={"dot-spinner__dot"}></div>
                            <div className={"dot-spinner__dot"}></div>
                            <div className={"dot-spinner__dot"}></div>
                            <div className={"dot-spinner__dot"}></div>
                            <div className={"dot-spinner__dot"}></div>
                            <div className={"dot-spinner__dot"}></div>
                        </div>
                    </div>
                    {isVisibleoverlayCancelButton &&
                        <button
                            className={"cancel-button"}
                            onClick={allGitCommandCancel}
                            style={{
                                position: 'absolute',
                                top: '70%',
                                left: '50%',
                                transform: 'translate(-50%,-50%)',
                                width: '150px'
                            }}>
                            Cancel
                        </button>
                    }
                </div>
            </div>

            {/*ブロックなしオーバーレイ*/}
            <div id={"overlay-no-block-panel"}>
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                }}>
                    <div style={{
                        position: 'absolute',
                        top: '93%',
                        left: '95%',
                        transform: 'translate(-50%,-50%)'
                    }}>
                        <div className={"dot-spinner"}>
                            <div className={"dot-spinner__dot"}></div>
                            <div className={"dot-spinner__dot"}></div>
                            <div className={"dot-spinner__dot"}></div>
                            <div className={"dot-spinner__dot"}></div>
                            <div className={"dot-spinner__dot"}></div>
                            <div className={"dot-spinner__dot"}></div>
                            <div className={"dot-spinner__dot"}></div>
                            <div className={"dot-spinner__dot"}></div>
                        </div>
                    </div>
                </div>
            </div>


            {/*右クリックメニュー*/}
            {
                contextMenu.visible && (
                    <ul
                        style={{
                            position: 'absolute',
                            top: contextMenu.y,
                            left: contextMenu.x,
                            backgroundColor: 'rgba(0,0,0,0.2)',
                            color: 'white',
                            textShadow: 'none',
                            listStyle: 'none',
                            padding: '5px',
                            borderRadius: '5px',
                        }}
                    >
                        <li
                            onClick={discardChanges}
                            style={{
                                cursor: 'pointer',
                                padding: '5px',
                                backgroundColor: 'rgba(0, 0, 0, 0.4)',
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.6)'}
                            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.4)'}
                        >
                            変更を破棄
                        </li>
                        <li
                            onClick={() => openFileLocation(contextMenu.statusInfo.filename)}
                            style={{
                                cursor: 'pointer',
                                padding: '5px',
                                backgroundColor: 'rgba(0,0,0,0.4)'
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.6)'}
                            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.4)'}
                        >
                            ファイルの場所を開く
                        </li>
                    </ul>
                )
            }

            {/*右クリックメニュー ブランチパネル*/}
            {
                contextMenu_branch.visible && (
                    <ul
                        style={{
                            position: 'absolute',
                            top: contextMenu_branch.y,
                            left: contextMenu_branch.x,
                            backgroundColor: 'rgba(0,0,0,0.2)',
                            color: 'white',
                            textShadow: 'none',
                            listStyle: 'none',
                            padding: '5px',
                            borderRadius: '5px',
                        }}
                    >
                        {
                            contextMenu_branch.branchInfo.branch_state === BranchState.Remote ? (
                                <li
                                    onClick={() => gitBranchCheckout(contextMenu_branch.branchInfo.branch_name)}
                                    style={{
                                        cursor: 'pointer',
                                        padding: '5px',
                                        backgroundColor: 'rgba(0, 0, 0, 0.4)',
                                    }}
                                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.6)'}
                                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.4)'}
                                >
                                    チェックアウト (ローカルブランチ作成)
                                </li>
                            ) : (
                                <li
                                    onClick={() => gitBranchCheckout(contextMenu_branch.branchInfo.branch_name)}
                                    style={{
                                        cursor: 'pointer',
                                        padding: '5px',
                                        backgroundColor: 'rgba(0, 0, 0, 0.4)',
                                    }}
                                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.6)'}
                                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.4)'}
                                >
                                    チェックアウト
                                </li>
                            )
                        }
                        <li
                            onClick={() => gitBranchMerge(contextMenu_branch.branchInfo.branch_name)}
                            style={{
                                cursor: 'pointer',
                                padding: '5px',
                                backgroundColor: 'rgba(0,0,0,0.4)'
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.6)'}
                            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.4)'}
                        >
                            現在のブランチにこのブランチをマージ
                        </li>
                        {
                            contextMenu_branch.branchInfo.branch_state !== BranchState.Remote &&
                            <li
                                onClick={() => gitBranchDelete(contextMenu_branch.branchInfo.branch_name)}
                                style={{
                                    cursor: 'pointer',
                                    padding: '5px',
                                    backgroundColor: 'rgba(0,0,0,0.4)'
                                }}
                                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.6)'}
                                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.4)'}
                            >
                                削除
                            </li>
                        }
                    </ul>
                )
            }

            {/*右クリックメニュー logパネル ログ上*/}
            {
                contextMenu_log.visible && (
                    <ul
                        style={{
                            position: 'absolute',
                            top: contextMenu_log.y,
                            left: contextMenu_log.x,
                            backgroundColor: 'rgba(0,0,0,0.2)',
                            color: 'white',
                            textShadow: 'none',
                            listStyle: 'none',
                            padding: '5px',
                            borderRadius: '5px',
                        }}
                    >
                        <li
                            onClick={() => gitCheckoutHash(contextMenu_log.commitInfo.hash)}
                            style={{
                                cursor: 'pointer',
                                padding: '5px',
                                backgroundColor: 'rgba(0,0,0,0.4)'
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.6)'}
                            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.4)'}
                        >
                            このコミットにチェックアウト
                        </li>
                    </ul>
                )
            }
        </div>
    );
}

export default App;
