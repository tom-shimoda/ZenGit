import React, {useRef} from "react";
import ReactDOM from "react-dom/client";

import "./App.scss"
import {useState, useEffect} from 'react';
import {invoke} from "@tauri-apps/api/tauri";
import {emit, listen} from "@tauri-apps/api/event";
import {getCurrent} from "@tauri-apps/api/window";
import {event} from "@tauri-apps/api";

const GitCommand = {
    Show: "git_show",
    ShowFiles: "git_show_files",
    ShowFileDiff: "git_show_file_diff",

} as const;

enum ChangeState {
    Unknown,
    Change,
    Staging,
    Delete,
    Add,
}

class StatusInfo {
    constructor() {
        this.change_state = ChangeState.Unknown;
        this.filename = '';
    }

    change_state: number;
    filename: string;
}

class ShowInfo {
    constructor() {
        this.hash = '';
        this.author = '';
        this.date = '';
        this.message = '';
    }

    hash: string;
    author: string;
    date: string;
    message: string;
}

interface EmitMessage<T> {
    is_ok: boolean;
    result: T;
}

let cancelCmds: string[] = [];
let cancelNoBlockCmds: string[] = [];

function NewWindow() {
    const [hash, setHash] = useState<string>('')
    const [longHash, setLongHash] = useState<string>('');
    const [author, setAuthor] = useState<string>('');
    const [date, setDate] = useState<string>('');
    const [message, setMessage] = useState<string>('');
    const [files, setFiles] = useState<StatusInfo[]>([]);

    const [leftPanelWidth, setLeftPanelWidth] = useState<number>(200); // Initial width of left panel
    const [selectedFile, setSelectedFile] = useState("");
    const [diffResult, setDiffResult] = useState("");
    const [sideBySide, setSideBySide] = useState(false);
    const [isVisibleoverlayCancelButton, setIsVisibleoverlayCancelButton] = useState(true);

    const diffScrollRef = useRef<HTMLDivElement>(null);
    const diffScrollLeftRef = useRef<HTMLDivElement>(null);
    const diffScrollRightRef = useRef<HTMLDivElement>(null);

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

    const postCommitHush = async (hash: string) => {
        setHash(hash);

        await Promise.all([
            gitShow(hash),
            gitShowFiles(hash),
        ]);
    }

    const init = async () => {
        const unlisten = listen<string>('commit-hash', (event) => {
            postCommitHush(event.payload);
        });

        // git結果受信イベント
        const showResult = listen<EmitMessage<ShowInfo>>('post-git-show-result', (event) => {
            recieveShowResult(event);
        });
        const showFilesResult = listen<EmitMessage<StatusInfo[]>>('post-git-show-files-result', (event) => {
            recieveShowFilesResult(event);
        });
        const showFileDiffResultEvent = listen<EmitMessage<string>>('post-git-show-file-diff-result', (event) => {
            recieveShowFileDiffResult(event);
        });

        // フロントエンドが準備完了を通知
        await emit('ready-to-receive', getCurrent().label);

        return () => {
            unlisten.then(f => f());
            showResult.then(f => f());
            showFilesResult.then(f => f());
            showFileDiffResultEvent.then(f => f());
        };
    }

    useEffect(() => {
        init();
    }, []);

    // Set initial X and panel width
    let initialX: number;
    let initialPanelWidth: number;

    // Mouse down event on the resizable bar
    const handleResizeMouseDown = (e: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
        initialX = e.clientX;
        initialPanelWidth = leftPanelWidth;
        document.addEventListener('mousemove', handleResizeMouseMove);
        document.addEventListener('mouseup', handleResizeMouseUp);
    };

    // Mouse move event for resizing
    const handleResizeMouseMove = (e: globalThis.MouseEvent) => {
        // Here, we calculate the new panel width based on the movement of the mouse.
        const newPanelWidth = initialPanelWidth + e.clientX - initialX;
        setLeftPanelWidth(newPanelWidth);
    };

    // Clean up the event listeners
    const handleResizeMouseUp = () => {
        document.removeEventListener('mousemove', handleResizeMouseMove);
        document.removeEventListener('mouseup', handleResizeMouseUp);
    };

    const gitShow = async (hash: string) => {
        try {
            showOverlay(GitCommand.Show, false);
            await invoke(GitCommand.Show, {windowLabel: getCurrent().label, hash});
        } catch (error) {
            console.error("Failed to git show:", error);
        }
    };

    const recieveShowResult = async (event: event.Event<EmitMessage<ShowInfo>>) => {
        const result = event.payload;
        if (!result.is_ok) {
            console.error(result.result);
            return;
        }

        setLongHash(result.result.hash);
        setAuthor(result.result.author);
        setDate(result.result.date);
        setMessage(result.result.message);

        hideOverlay(GitCommand.Show);
    }

    const gitShowFiles = async (hash: string) => {
        try {
            showOverlay(GitCommand.ShowFiles, false);
            await invoke(GitCommand.ShowFiles, {windowLabel: getCurrent().label, hash});
        } catch (error) {
            console.error("Failed to git show files:", error);
        }
    };

    const recieveShowFilesResult = async (event: event.Event<EmitMessage<StatusInfo[]>>) => {
        const result = event.payload;
        if (!result.is_ok) {
            console.error(result.result);
            return;
        }

        setFiles(result.result);

        hideOverlay(GitCommand.ShowFiles);
    }

    const updateDiff = async (file: string) => {
        await gitDiffCancel();

        if (!file) return;
        await gitShowFileDiff(file);
    };

    const gitDiffCancel = async () => {
        try {
            await invoke("git_show_file_diff_cancel", {windowLabel: getCurrent().label});
            hideNoBlockOverlay(GitCommand.ShowFileDiff);
        } catch (error) {
            console.error("Failed to cancel:", error);
            alert("ERROR: Failed to cancel\n" + error);
        }
    };


    const gitShowFileDiff = async (file: string) => {
        try {
            showNoBlockOverlay(GitCommand.ShowFileDiff);
            await invoke<string>(GitCommand.ShowFileDiff, {windowLabel: getCurrent().label, hash: hash, file: file});
        } catch (error) {
            console.error("Failed to fetch git show file diff:", error);
        }
    };

    const recieveShowFileDiffResult = async (event: event.Event<EmitMessage<string>>) => {
        const result = event.payload;
        if (!result.is_ok) {
            console.error(result.result);
            return;
        }

        // スクロール位置をTOPに
        if (diffScrollRef.current) {
            diffScrollRef.current.scrollTop = 0;
        }

        if (result.result) {
            setDiffResult(result.result);
        } else {
            setDiffResult("");
        }

        hideNoBlockOverlay(GitCommand.ShowFileDiff);
    }

    // Handle file click
    const handleFileClick = async (file: string) => {
        setSelectedFile(file);

        await updateDiff(file);
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

    class LineWithStyle {
        constructor(public text: string, public style: React.CSSProperties) {
        }
    }

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
                line.startsWith('Binary ')
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

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100vh',
            backgroundColor: '#EBECF0'
        }}>
            <div style={{
                margin: '10px 20px 0px 20px',
                userSelect: 'text', // テキスト選択を有効に
                WebkitUserSelect: 'text', // テキスト選択を有効 forMac (参考: https://github.com/tauri-apps/tauri/issues/5016)
                cursor: 'auto', // テキスト上ではカーソルを変更する
            }}>
                <div>{longHash}</div>
                <div>{author}</div>
                <div>{date}</div>
                <pre>{message}</pre>
            </div>


            <div style={{display: 'flex', flex: 1, overflow: 'hidden'}}>

                {/* left panel */}
                <div className={"card middle-frame"} style={{
                    width: leftPanelWidth,
                    display: 'flex',
                    flexDirection: 'column',
                    margin: '15px 10px 8px 20px',
                    rowGap: '10px'
                }}>
                    <div style={{flex: 1, overflowY: 'auto'}}>
                        <ul style={{paddingLeft: '0px', margin: '0px', width: 'fit-content'}}>
                            {files.map((file, index) => (
                                <li
                                    key={index}
                                    onClick={() => handleFileClick(file.filename)}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        backgroundColor: selectedFile === file.filename ? '#ddd' : 'transparent',
                                        borderRadius: '5px'
                                    }}
                                >
                                    <div style={{
                                        color: getColorForStatus(file.change_state),
                                        textDecoration: file.change_state === ChangeState.Delete ? 'line-through' : 'none',
                                        margin: '6px',
                                    }}>
                                        {getFileNameWithChangeState(file)}
                                    </div>
                                </li>
                            ))}
                        </ul>
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
                    onMouseDown={handleResizeMouseDown}
                />

                {/* right panel*/}
                <div className={"card middle"}
                     style={{
                         width: `calc(100% - ${leftPanelWidth}px)`,
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
            </div>
        </div>
    );
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    // <React.StrictMode>
    <NewWindow/>
    // </React.StrictMode>
);
