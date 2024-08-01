// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]


mod platform;

use std::borrow::Cow;
use tauri::{AppHandle, command, Manager, WindowUrl};
use std::process::{Output, Stdio};
use std::str::FromStr;
use serde::{Deserialize, Serialize};
use serde_repr::{Deserialize_repr, Serialize_repr};
use tauri::regex::Regex;
use crate::platform::CommandCreationFlags;
use tauri::api::path::{app_config_dir, home_dir};
use std::fs::{self, create_dir_all, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use log::info;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;
use futures::future::{err, FutureExt, ok};
use log::Level::Error;
use tokio::sync::Mutex;
use once_cell::sync::Lazy;
use tauri::http::header::CONTENT_SECURITY_POLICY_REPORT_ONLY;
use tauri::regex::bytes::RegexSet;
use window_shadows::set_shadow;

static GLOBAL_CANCELLATION_TOKENS: Lazy<Arc<Mutex<Vec<TaskHandle>>>> = Lazy::new(|| {
    Arc::new(Mutex::new(vec![]))
});

#[derive(Clone)]
struct TaskHandle {
    git_command_label: &'static str,
    window_label: String,
    token: CancellationToken,
    is_running: bool,
}

impl TaskHandle {
    fn new() -> Self {
        TaskHandle {
            git_command_label: "",
            window_label: "".to_string(),
            token: CancellationToken::new(),
            is_running: false,
        }
    }

    fn get_token(&self) -> CancellationToken {
        self.token.clone()
    }

    fn run(&mut self) {
        self.is_running = true;
    }

    fn done(&mut self) {
        self.is_running = false;
    }

    fn cancel(&mut self) {
        self.token.cancel();
        self.done();

        self.token = CancellationToken::new(); // 新しいトークンを生成
    }
}

async fn is_running_command(git_command_label: &'static str, window_label: String) -> bool {
    let mut guard = GLOBAL_CANCELLATION_TOKENS.lock().await;

    // 既存のトークンを検索
    if let Some(task) = guard.iter().find(
        |v| v.git_command_label == git_command_label && v.window_label == window_label)
    {
        if task.is_running {
            println!("Task is running: {} for window: {}", git_command_label, window_label);
        }

        return task.is_running;
    }

    return false;
}

async fn create_task(git_command_label: &'static str, window_label: String) -> TaskHandle {
    let mut guard = GLOBAL_CANCELLATION_TOKENS.lock().await;

    // 既存のトークンを検索
    if let Some(task) = guard.iter_mut().find(
        |v| v.git_command_label == git_command_label && v.window_label == window_label)
    {
        println!("Do task: {} for window: {}", git_command_label, window_label);

        task.run();
        return task.clone(); // 既存のトークンを返す
    }

    // 新しいトークンを生成
    let mut new_task = TaskHandle::new();
    new_task.git_command_label = git_command_label;
    new_task.window_label = window_label.clone();

    new_task.run();
    let new_task_clone = new_task.clone();
    guard.push(new_task);

    println!("Added task: {} for window: {}", git_command_label, window_label);

    new_task_clone
}

async fn done_task(git_command_label: &'static str, window_label: String) {
    let mut guard = GLOBAL_CANCELLATION_TOKENS.lock().await;
    if let Some(task) = guard.iter_mut().find(
        |v| v.git_command_label == git_command_label && v.window_label == window_label)
    {
        task.done();
        println!("Done task: {} for window: {}", git_command_label, window_label);
    } else {
        println!("Task not found: {} for window: {}", git_command_label, window_label);
    }
}

async fn cancel_task(git_command_label: &'static str, window_label: String) {
    let mut guard = GLOBAL_CANCELLATION_TOKENS.lock().await;
    if let Some(task) = guard.iter_mut().find(
        |v| v.git_command_label == git_command_label && v.window_label == window_label)
    {
        task.cancel();
        println!("Cancelled task: {} for window: {}", git_command_label, window_label);
    } else {
        println!("Task not found: {} for window: {}", git_command_label, window_label);
    }
}

// Typescript側のenumがswitch-caseで正しく動作しなかったのでu8としてserialize
#[derive(Debug, Serialize_repr, Deserialize_repr, PartialEq)]
#[repr(u8)]
enum ChangeState {
    Unknown = 0,
    Change = 1,
    Staging = 2,
    Delete = 3,
    Add = 4,
}

#[derive(Debug, Serialize_repr, Deserialize_repr, PartialEq)]
#[repr(u8)]
enum BranchState {
    Unknown = 0,
    Default = 1,
    Current = 2,
    Remote = 3,
    All = 4,
}

#[derive(Debug, Serialize, Deserialize)]
struct StatusInfo {
    change_state: ChangeState,
    filename: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct EmitMessage<T> {
    is_ok: bool,
    result: T,
}

async fn run_git_command<F>(app_handle: AppHandle,
                            window_label: &str,
                            mut task: TaskHandle,
                            command: &mut Command,
                            emit_event_name: &str,
                            on_success: F)
                            -> Result<String, String> where F: Fn(AppHandle, &str, &String) {
    let cancellation_token = task.token.clone(); // キャンセルトークンをクローン

    // キャンセルトークンを使って非同期に待機
    let result = tokio::select! {
        _ = cancellation_token.cancelled() => {
            // キャンセルされた場合、プロセスを強制終了
            return Ok("Operation was cancelled.".to_string() + ": " + emit_event_name);
        }
        // コマンド実行
        result = async {
            // tokio::time::sleep(std::time::Duration::from_secs(3)).await; // TODO: debug
    
            let output = command.set_creation_flags().output().await;
            match output {
                Ok(output) => {
                    if output.status.success() {
                        let output = String::from_utf8_lossy(&output.stdout).to_string();
                        on_success(app_handle, window_label, &output);
                        Ok(output)
                    } else {
                        let output = String::from_utf8_lossy(&output.stderr).to_string();
                        let message = EmitMessage{
                            is_ok:false,
                            result: &output
                        };
                        post_git_command_result(app_handle, window_label, &message, emit_event_name);
                        Err(output)
                    }
                }
                Err(e) => {
                    let message = EmitMessage{
                        is_ok:false,
                        result: &e.to_string()
                    };
                    post_git_command_result(app_handle, window_label, &message, emit_event_name);
                    Err(e.to_string())
                }
            }
        } => {
            result
        }
    };

    done_task(task.git_command_label, task.window_label).await;
    result
}

fn post_git_command_result<T: Serialize>(app_handle: AppHandle, window_label: &str, result: &EmitMessage<T>, emit_event_name: &str) {
    app_handle.app_handle()
        .emit_to(window_label, emit_event_name, result)
        .unwrap();
}

const GIT_STATUS_COMMAND: &str = "git_status";

#[command]
async fn git_status(app_handle: AppHandle, window_label: String) -> Result<(), String> {
    // 実行中かどうかをチェック
    if is_running_command(GIT_STATUS_COMMAND, window_label.clone()).await {
        return Err("The command is running".to_string());
    }

    // unstagingしておく
    let _ = Command::new("git").arg("reset").set_creation_flags().output().await;


    const RESULT_LABLE: &str = "post-git-status-result";

    // CancellationTokenをクローンして非同期タスクに渡す
    let task = create_task(GIT_STATUS_COMMAND, window_label.clone()).await;

    tokio::spawn(async move {
        let mut binding = Command::new("git");
        let command = binding
            .kill_on_drop(true)
            .arg("status")
            .arg("-s")
            .arg("-uall");
        match run_git_command(app_handle,
                              window_label.as_str(),
                              task,
                              command,
                              RESULT_LABLE,
                              |h, wl, o| {
                                  let lines: Vec<StatusInfo> = o
                                      .lines()
                                      .map(|line| {
                                          let (_, file) = line.split_at(3);
                                          let filename = file.trim().to_string();
                                          match &line[0..2] {
                                              " M" => {
                                                  StatusInfo { change_state: ChangeState::Change, filename }
                                              }
                                              "M " => {
                                                  StatusInfo { change_state: ChangeState::Staging, filename }
                                              }
                                              " D" => {
                                                  StatusInfo { change_state: ChangeState::Delete, filename }
                                              }
                                              "??" => {
                                                  StatusInfo { change_state: ChangeState::Add, filename }
                                              }
                                              // git処理が遅く、新規追加ファイルのdiffを取るための`git add -N`処理後の`git diff`実行中に
                                              // `git status`が走った場合、stagingファイル扱いとなる。
                                              // `git status`のタイミングの関係でstaging扱いとなるが、その後の`git diff`完了後に
                                              // `git reset`が行われるためUntrackedに戻ってはいるはずなので問題はない。
                                              " A" => {
                                                  StatusInfo { change_state: ChangeState::Add, filename }
                                              }
                                              _ => {
                                                  StatusInfo { change_state: ChangeState::Unknown, filename }
                                              }
                                          }
                                      })
                                      .collect();

                                  let message = EmitMessage {
                                      is_ok: true,
                                      result: &lines,
                                  };
                                  post_git_command_result(h, wl, &message, RESULT_LABLE);
                              },
        ).await {
            Ok(output) => {}
            Err(e) => {}
        }
    });

    Ok(())
}

#[command]
async fn git_status_cancel(window_label: String) {
    cancel_task(GIT_STATUS_COMMAND, window_label).await;
}

const GIT_DIFF_COMMAND: &str = "git_diff";

#[command]
async fn git_diff(app_handle: AppHandle, window_label: String, file: String) -> Result<(), String> {
    // 新規追加ファイルのdiffを取るため`git add -N`しておく
    let _ = Command::new("git").arg("add").arg("-N").arg(&file).set_creation_flags().output().await;
    
    const RESULT_LABEL: &str = "post-git-diff-result";

    // CancellationTokenをクローンして非同期タスクに渡す
    let task = create_task(GIT_DIFF_COMMAND, window_label.clone()).await;

    tokio::spawn(async move {
        let mut binding = Command::new("git");
        let command = binding
            .kill_on_drop(true)
            .arg("diff")
            .arg(file);
        match run_git_command(app_handle,
                              window_label.as_str(),
                              task,
                              command,
                              RESULT_LABEL,
                              |h, wl, o| {
                                  let message = EmitMessage {
                                      is_ok: true,
                                      result: &o,
                                  };
                                  post_git_command_result(h, wl, &message, RESULT_LABEL);

                                  // 新規追加ファイルのdiffを取るための`git add -N`を元に戻す
                                  let _ = Command::new("git").arg("reset").set_creation_flags().output();
                              },
        ).await {
            Ok(output) => {}
            Err(e) => {
                // 新規追加ファイルのdiffを取るための`git add -N`を元に戻す
                let _ = Command::new("git").arg("reset").set_creation_flags().output();
            }
        }
    });

    Ok(())
}

#[command]
async fn git_diff_cancel(window_label: String) {
    cancel_task(GIT_DIFF_COMMAND, window_label).await;

    // 新規追加ファイルのdiffを取るための`git add -N`を元に戻す
    let _ = Command::new("git").arg("reset").set_creation_flags().output().await;
}

const GIT_DISCARD_CHANGES_ADDS_COMMAND: &str = "git_discard_changes_adds";
const GIT_DISCARD_CHANGES_OTHERS_COMMAND: &str = "git_discard_changes_others";

// 変更を破棄する関数
#[command]
async fn git_discard_changes(app_handle: AppHandle, window_label: String, infos: Vec<StatusInfo>) -> Result<(), String> {
    // 実行中かどうかをチェック
    if is_running_command(GIT_DISCARD_CHANGES_ADDS_COMMAND, window_label.clone()).await ||
        is_running_command(GIT_DISCARD_CHANGES_OTHERS_COMMAND, window_label.clone()).await {
        return Err("The command is running".to_string());
    }

    let (adds, others): (Vec<StatusInfo>, Vec<StatusInfo>) = infos.into_iter().partition(|status_info| status_info.change_state == ChangeState::Add);


    const RESULT_LABEL_ADDS: &str = "post-git-discard-changes-adds-result";

    let app_handle_adds = app_handle.clone();
    let window_label_adds = window_label.clone();
    if !&adds.is_empty() {
        // CancellationTokenをクローンして非同期タスクに渡す
        let task_adds = create_task(GIT_DISCARD_CHANGES_ADDS_COMMAND, window_label_adds.clone()).await;

        let app_handle_clone = app_handle_adds.clone();
        let window_label_clone = window_label_adds.clone();
        tokio::spawn(async move {
            let mut binding = Command::new("git");
            let command_adds = binding.arg("clean").arg("-f");
            for v in adds {
                command_adds.arg(&v.filename);
            }
            match run_git_command(app_handle_clone,
                                  window_label_clone.as_str(),
                                  task_adds,
                                  command_adds,
                                  RESULT_LABEL_ADDS,
                                  |h, wl, o| {
                                      let message = EmitMessage {
                                          is_ok: true,
                                          result: &o,
                                      };
                                      post_git_command_result(h, wl, &message, RESULT_LABEL_ADDS);
                                  },
            ).await {
                Ok(output) => {}
                Err(e) => {}
            }
        });
    } else {
        let message = EmitMessage {
            is_ok: true,
            result: &"".to_string(),
        };
        post_git_command_result(app_handle_adds, window_label_adds.as_str(), &message, RESULT_LABEL_ADDS);
    }


    const REUSLT_LABEL_OTHERS: &str = "post-git-discard-changes-others-result";

    let app_handle_others = app_handle.clone();
    let window_label_others = window_label.clone();
    if !&others.is_empty() {
        // CancellationTokenをクローンして非同期タスクに渡す
        let task_others = create_task(GIT_DISCARD_CHANGES_OTHERS_COMMAND, window_label_others.clone()).await;

        let app_handle_clone = app_handle_others.clone();
        let window_label_clone = window_label_others.clone();
        tokio::spawn(async move {
            let mut binding = Command::new("git");
            let command_others = binding.arg("checkout").arg("--");
            for v in others {
                command_others.arg(&v.filename);
            }
            match run_git_command(app_handle_clone,
                                  window_label_clone.as_str(),
                                  task_others,
                                  command_others,
                                  REUSLT_LABEL_OTHERS,
                                  |h, wl, o| {
                                      let message = EmitMessage {
                                          is_ok: true,
                                          result: &o,
                                      };
                                      post_git_command_result(h, wl, &message, REUSLT_LABEL_OTHERS);
                                  },
            ).await {
                Ok(output) => {}
                Err(e) => {}
            }
        });
    } else {
        let message = EmitMessage {
            is_ok: true,
            result: &"".to_string(),
        };
        post_git_command_result(app_handle_others, window_label_others.as_str(), &message, REUSLT_LABEL_OTHERS);
    }

    Ok(())
}

#[command]
async fn git_discard_changes_adds_cancel(window_label: String) {
    cancel_task(GIT_DISCARD_CHANGES_ADDS_COMMAND, window_label).await;
}

#[command]
async fn git_discard_changes_others_cancel(window_label: String) {
    cancel_task(GIT_DISCARD_CHANGES_OTHERS_COMMAND, window_label).await;
}

// ファイルの場所を開く関数 (macOSとWindowsに対応)
#[command]
async fn open_file_location(file: &str) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        match Command::new("open").arg("-R").arg(file).output().await {
            Ok(_) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    } else if cfg!(target_os = "windows") {
        let mut path: String;
        if let Some(parent) = Path::new(file).parent() {
            path = parent.to_string_lossy().into_owned();
        } else {
            path = file.to_string();
        }

        path = path.replace("/", "\\");

        match Command::new("explorer").arg(path).output().await {
            Ok(_) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    } else {
        Err("Unsupported operating system".into())
    }
}

const GIT_COMMIT_COMMAND: &str = "git_commit";

#[command]
async fn git_commit(app_handle: AppHandle, window_label: String, files: Vec<String>, message: String) -> Result<(), String> {
    // 実行中かどうかをチェック
    if is_running_command(GIT_COMMIT_COMMAND, window_label.clone()).await {
        return Err("The command is running".to_string());
    }

    const RESULT_LABEL: &str = "post-git-commit-result";

    // CancellationTokenをクローンして非同期タスクに渡す
    let task = create_task(GIT_COMMIT_COMMAND, window_label.clone()).await;

    tokio::spawn(async move {
        let mut binding = Command::new("git");
        let command: &mut Command;
        if !message.is_empty() {
            command = binding.arg("commit").arg("-m").arg(message);
        } else {
            command = binding.arg("commit").arg("--amend").arg("--no-edit");
        }

        // stagingする
        let mut staging = Command::new("git");
        staging.arg("add");
        for file in files {
            staging.arg(&file);

            // コミット対象として追加
            command.arg(file);
        }
        let _ = staging.set_creation_flags().output().await;

        match run_git_command(app_handle,
                              window_label.as_str(),
                              task,
                              command,
                              RESULT_LABEL,
                              |h, wl, o| {
                                  let message = EmitMessage {
                                      is_ok: true,
                                      result: &o,
                                  };
                                  post_git_command_result(h, wl, &message, RESULT_LABEL);
                              },
        ).await {
            Ok(output) => {}
            Err(e) => {}
        }
    });

    Ok(())
}

#[command]
async fn git_commit_cancel(window_label: String) {
    cancel_task(GIT_COMMIT_COMMAND, window_label).await;
}

const GIT_PUSH_COMMAND: &str = "git_push";

#[command]
async fn git_push(app_handle: AppHandle, window_label: String) -> Result<(), String> {
    // 実行中かどうかをチェック
    if is_running_command(GIT_PUSH_COMMAND, window_label.clone()).await {
        return Err("The command is running".to_string());
    }

    const RESULT_LABEL: &str = "post-git-push-result";

    // CancellationTokenをクローンして非同期タスクに渡す
    let task = create_task(GIT_PUSH_COMMAND, window_label.clone()).await;

    tokio::spawn(async move {
        let mut binding = Command::new("git");
        let command = binding
            .kill_on_drop(true)
            .arg("push")
            .arg("-u")
            .arg("origin")
            .arg("HEAD");
        match run_git_command(app_handle,
                              window_label.as_str(),
                              task,
                              command,
                              RESULT_LABEL,
                              |h, wl, o| {
                                  let message = EmitMessage {
                                      is_ok: true,
                                      result: &"Push Success!".to_string(),
                                  };
                                  post_git_command_result(h, wl, &message, RESULT_LABEL);
                              },
        ).await {
            Ok(output) => {
                println!("ok: {}", output)
            }
            Err(e) => {
                println!("err: {}", e)
            }
        }
    });

    Ok(())
}

#[command]
async fn git_push_cancel(window_label: String) {
    cancel_task(GIT_PUSH_COMMAND, window_label).await;
}

const GIT_PULL_COMMAND: &str = "git_pull";

#[command]
async fn git_pull(app_handle: AppHandle, window_label: String) -> Result<(), String> {
    // 実行中かどうかをチェック
    if is_running_command(GIT_PULL_COMMAND, window_label.clone()).await {
        return Err("The command is running".to_string());
    }

    const RESULT_LABEL: &str = "post-git-pull-result";

    // CancellationTokenをクローンして非同期タスクに渡す
    let task = create_task(GIT_PULL_COMMAND, window_label.clone()).await;

    tokio::spawn(async move {
        let mut binding = Command::new("git");
        let command = binding
            .kill_on_drop(true)
            .arg("pull")
            .arg("--prune");
        match run_git_command(app_handle,
                              window_label.as_str(),
                              task,
                              command,
                              RESULT_LABEL,
                              |h, wl, o| {
                                  let message = EmitMessage {
                                      is_ok: true,
                                      result: &"Pull Success!".to_string(),
                                  };
                                  post_git_command_result(h, wl, &message, RESULT_LABEL);
                              },
        ).await {
            Ok(output) => {
                println!("ok: {}", output)
            }
            Err(e) => {
                println!("err: {}", e)
            }
        }
    });

    Ok(())
}

#[command]
async fn git_pull_cancel(window_label: String) {
    cancel_task(GIT_PULL_COMMAND, window_label).await;
}

const GIT_FETCH_COMMAND: &str = "git_fetch";

#[command]
async fn git_fetch(app_handle: AppHandle, window_label: String) -> Result<(), String> {
    // 実行中かどうかをチェック
    if is_running_command(GIT_FETCH_COMMAND, window_label.clone()).await {
        return Err("The command is running".to_string());
    }

    const RESULT_LABEL: &str = "post-git-fetch-result";

    // CancellationTokenをクローンして非同期タスクに渡す
    let task = create_task(GIT_FETCH_COMMAND, window_label.clone()).await;

    tokio::spawn(async move {
        let mut binding = Command::new("git");
        let command = binding
            .kill_on_drop(true)
            .arg("fetch")
            .arg("--prune");
        match run_git_command(app_handle,
                              window_label.as_str(),
                              task,
                              command,
                              RESULT_LABEL,
                              |h, wl, o| {
                                  let message = EmitMessage {
                                      is_ok: true,
                                      result: &o,
                                  };
                                  post_git_command_result(h, wl, &message, RESULT_LABEL);
                              },
        ).await {
            Ok(output) => {}
            Err(e) => {}
        }
    });

    Ok(())
}

#[command]
async fn git_fetch_cancel(window_label: String) {
    cancel_task(GIT_FETCH_COMMAND, window_label).await;
}

// (&str と String を両方取れるようにする: https://qiita.com/yasuo-ozu/items/987b7c4a7e2ebab098a4)
fn extract_ahead_behind_counts<'a, S: Into<Cow<'a, str>>>(s: S) -> Result<(u16, u16), &'static str> {
    let s: Cow<'a, str> = s.into();
    let status: &str = &s;
    let re = Regex::new(r"(?:(ahead (\d+))|(behind (\d+)))").map_err(|_| "Failed to compile regex")?;

    let mut ahead_count = 0;
    let mut behind_count = 0;

    for cap in re.captures_iter(status) {
        if let Some(ahead) = cap.get(2) {
            ahead_count = u16::from_str(ahead.as_str()).map_err(|_| "Failed to parse ahead count")?;
        }
        if let Some(behind) = cap.get(4) {
            behind_count = u16::from_str(behind.as_str()).map_err(|_| "Failed to parse behind count")?;
        }
    }

    Ok((ahead_count, behind_count))
}


#[derive(Debug, Serialize, Deserialize)]
struct PullPushCountInfo {
    push_count: u16,
    pull_count: u16,
}

const GET_PULL_PUSH_COUNT_COMMAND: &str = "get_pull_push_count";

#[command]
async fn get_pull_push_count(app_handle: AppHandle, window_label: String) -> Result<(), String> {
    // 実行中かどうかをチェック
    if is_running_command(GET_PULL_PUSH_COUNT_COMMAND, window_label.clone()).await {
        return Err("The command is running".to_string());
    }

    const RESULT_LABEL: &str = "post-get-pull-push-count";

    // CancellationTokenをクローンして非同期タスクに渡す
    let task = create_task(GET_PULL_PUSH_COUNT_COMMAND, window_label.clone()).await;

    tokio::spawn(async move {
        let mut binding = Command::new("git");
        let command = binding
            .kill_on_drop(true)
            .arg("status")
            .arg("-sb");
        match run_git_command(app_handle,
                              window_label.as_str(),
                              task,
                              command,
                              RESULT_LABEL,
                              |h, wl, o| {
                                  let (ahead_count, behind_count) = extract_ahead_behind_counts(o).expect("Failed to extract counts");
                                  let res = PullPushCountInfo { push_count: ahead_count, pull_count: behind_count };

                                  let message = EmitMessage {
                                      is_ok: true,
                                      result: &res,
                                  };
                                  post_git_command_result(h, wl, &message, RESULT_LABEL);
                              },
        ).await {
            Ok(output) => {}
            Err(e) => {}
        }
    });

    Ok(())
}

#[command]
async fn get_pull_push_count_cancel(window_label: String) {
    cancel_task(GET_PULL_PUSH_COUNT_COMMAND, window_label).await;
}

// フォルダパスの保存先ディレクトリを取得する関数
fn get_app_config_dir() -> PathBuf {
    let mut config_dir = app_config_dir(&tauri::Config::default()).unwrap();
    config_dir.push("ZenGit");
    if !config_dir.exists() {
        create_dir_all(&config_dir).unwrap();
    }
    config_dir
}

// フォルダパスを保存する関数
fn save_folder_path(path: &str) -> io::Result<()> {
    let config_dir = get_app_config_dir();
    let file_path = config_dir.join("selected_git_folder.txt");
    let mut file = File::create(file_path)?;
    file.write_all(path.as_bytes())?;
    Ok(())
}

// フォルダパスを読み込む関数
fn load_folder_path() -> io::Result<String> {
    let config_dir = get_app_config_dir();
    let file_path = config_dir.join("selected_git_folder.txt");
    let mut path = fs::read_to_string(file_path)?;

    if !Path::new(&path).exists() {
        path = home_dir().unwrap()
            .to_str()
            .unwrap()
            .to_string();
    }

    Ok(path)
}

#[command]
fn select_git_folder() -> Result<String, String> {
    match rfd::FileDialog::new().pick_folder() {
        Some(path) => {
            let path_str = path.to_str().ok_or("Invalid path")?.to_string();
            save_folder_path(&path_str).map_err(|e| e.to_string())?;
            std::env::set_current_dir(&path).map_err(|e| e.to_string())?;
            Ok(path_str)
        }
        None => Err("No folder selected".into())
    }
}

#[command]
fn get_git_folder() -> Result<String, String> {
    match load_folder_path() {
        Ok(path) => Ok(path),
        Err(e) => Err(e.to_string())
    }
}

#[derive(Serialize)]
struct Commit {
    graph: String,
    hash: String,
    author: String,
    message: String,
    date: String,
    branch: String,
}

const GIT_LOG_COMMAND: &str = "git_log";

#[command]
async fn git_log(app_handle: AppHandle, window_label: String, is_show_all: bool, branch_name: String, is_first_parent: bool) -> Result<(), String> {
    // 実行中かどうかをチェック
    if is_running_command(GIT_LOG_COMMAND, window_label.clone()).await {
        return Err("The command is running".to_string());
    }

    const RESULT_LABEL: &str = "post-git-log-result";

    // CancellationTokenをクローンして非同期タスクに渡す
    let task = create_task(GIT_LOG_COMMAND, window_label.clone()).await;

    tokio::spawn(async move {
        let mut binding = Command::new("git");
        let command = binding
            .kill_on_drop(true)
            .arg("log")
            .arg("--graph")
            .arg("--color")
            .arg("--oneline")
            .arg("--date=format:%Y/%m/%d (%a) %H:%M")
            .arg("--format=___%h___%an___%s___%ad___%C(auto)%d%C(reset)");
        if is_show_all {
            command.arg("--all");
        } else {
            if is_first_parent {
                command.arg("--first-parent");
            }
            if !branch_name.is_empty() {
                command.arg(branch_name);
                command.arg("--"); // ファイル/フォルダ名とブランチ名が同じ場合エラーが出るためブランチ名として明示する (https://qiita.com/hakuisan/items/d2e40bec6d2785202885)
            }
        }

        match run_git_command(app_handle,
                              window_label.as_str(),
                              task,
                              command,
                              RESULT_LABEL,
                              |h, wl, o| {
                                  let res: Vec<Commit> = o
                                      .lines()
                                      .map(|line| {
                                          let parts: Vec<&str> = line.split("___").collect();
                                          if parts.len() > 1 {
                                              // コミットメッセージありの行
                                              Commit {
                                                  graph: parts[0].to_string(),
                                                  hash: parts[1].to_string(),
                                                  author: parts[2].to_string(),
                                                  message: parts[3].to_string(),
                                                  date: parts[4].to_string(),
                                                  branch: parts[5].to_string(),
                                              }
                                          } else {
                                              // コミットメッセージなしのブランチ表記のみの行
                                              Commit {
                                                  graph: parts[0].to_string(),
                                                  hash: "".to_string(),
                                                  author: "".to_string(),
                                                  message: "".to_string(),
                                                  date: "".to_string(),
                                                  branch: "".to_string()
                                              }
                                          }
                                      })
                                      .collect();

                                  let message = EmitMessage {
                                      is_ok: true,
                                      result: &res,
                                  };
                                  post_git_command_result(h, wl, &message, RESULT_LABEL);
                              },
        ).await {
            Ok(output) => {}
            Err(e) => {}
        }
    });

    Ok(())
}

#[command]
async fn git_log_cancel(window_label: String) {
    cancel_task(GIT_LOG_COMMAND, window_label).await;
}

#[derive(Serialize)]
struct ShowInfo {
    hash: String,
    author: String,
    date: String,
    message: String,
}

const GIT_SHOW_COMMAND: &str = "git_show";

#[command]
async fn git_show(app_handle: AppHandle, window_label: String, hash: String) -> Result<(), String> {
    // 実行中かどうかをチェック
    if is_running_command(GIT_SHOW_COMMAND, window_label.clone()).await {
        return Err("The command is running".to_string());
    }

    const RESULT_LABEL: &str = "post-git-show-result";

    // CancellationTokenをクローンして非同期タスクに渡す
    let task = create_task(GIT_SHOW_COMMAND, window_label.clone()).await;

    tokio::spawn(async move {
        let mut binding = Command::new("git");
        let command = binding
            .kill_on_drop(true)
            .arg("show")
            .arg("--pretty=format:%H%n%an%n%ad%n%B")
            .arg("--no-patch")
            .arg(&hash);
        match run_git_command(app_handle,
                              window_label.as_str(),
                              task,
                              command,
                              RESULT_LABEL,
                              |h, wl, o| {
                                  let mut lines = o.lines();

                                  // 最初の4行をパース
                                  let hash = lines.next().unwrap_or("").to_string();
                                  let author = lines.next().unwrap_or("").to_string();
                                  let date = lines.next().unwrap_or("").to_string();
                                  let message = lines.collect::<Vec<&str>>().join("\n");

                                  let res = ShowInfo {
                                      hash,
                                      author,
                                      date,
                                      message,
                                  };

                                  let message = EmitMessage {
                                      is_ok: true,
                                      result: &res,
                                  };
                                  post_git_command_result(h, wl, &message, RESULT_LABEL);
                              },
        ).await {
            Ok(output) => {}
            Err(e) => {}
        }
    });

    Ok(())
}

#[command]
async fn git_show_cancel(window_label: String) {
    cancel_task(GIT_SHOW_COMMAND, window_label).await;
}

const GIT_SHOW_FILES_COMMAND: &str = "git_show_files";

#[command]
async fn git_show_files(app_handle: AppHandle, window_label: String, hash: String) -> Result<(), String> {
    // 実行中かどうかをチェック
    if is_running_command(GIT_SHOW_FILES_COMMAND, window_label.clone()).await {
        return Err("The command is running".to_string());
    }

    const RESULT_LABEL: &str = "post-git-show-files-result";

    // CancellationTokenをクローンして非同期タスクに渡す
    let task = create_task(GIT_SHOW_FILES_COMMAND, window_label.clone()).await;

    tokio::spawn(async move {
        let mut binding = Command::new("git");
        let command = binding
            .kill_on_drop(true)
            .arg("show")
            .arg("--pretty=format:")
            .arg("--name-status")
            .arg(&hash);
        match run_git_command(app_handle,
                              window_label.as_str(),
                              task,
                              command,
                              RESULT_LABEL,
                              |h, wl, o| {
                                  let res: Vec<StatusInfo> = o
                                      .lines()
                                      .map(|line| {
                                          let (_, file) = line.split_at(2);
                                          let mut filename = file.trim().to_string();
                                          match &line[0..1] {
                                              "M" => {
                                                  StatusInfo { change_state: ChangeState::Change, filename }
                                              }
                                              "D" => {
                                                  StatusInfo { change_state: ChangeState::Delete, filename }
                                              }
                                              "A" => {
                                                  StatusInfo { change_state: ChangeState::Add, filename }
                                              }
                                              _ => {
                                                  StatusInfo { change_state: ChangeState::Unknown, filename }
                                              }
                                          }
                                      })
                                      .collect();

                                  let message = EmitMessage {
                                      is_ok: true,
                                      result: &res,
                                  };
                                  post_git_command_result(h, wl, &message, RESULT_LABEL);
                              },
        ).await {
            Ok(output) => {}
            Err(e) => {}
        }
    });

    Ok(())
}

#[command]
async fn git_show_files_cancel(window_label: String) {
    cancel_task(GIT_SHOW_FILES_COMMAND, window_label).await;
}

const GIT_SHOW_FILE_DIFF_COMMAND: &str = "git_show_file_diff";

// git show --pretty=format: <commit hash> -- <filename>
#[command]
async fn git_show_file_diff(app_handle: AppHandle, window_label: String, hash: String, file: String) -> Result<(), String> {
    // 実行中かどうかをチェック
    if is_running_command(GIT_SHOW_FILE_DIFF_COMMAND, window_label.clone()).await {
        return Err("The command is running".to_string());
    }

    const RESULT_LABEL: &str = "post-git-show-file-diff-result";

    // CancellationTokenをクローンして非同期タスクに渡す
    let task = create_task(GIT_SHOW_FILE_DIFF_COMMAND, window_label.clone()).await;

    tokio::spawn(async move {
        let mut binding = Command::new("git");
        let command = binding
            .kill_on_drop(true)
            .arg("show")
            .arg("--pretty=format:")
            .arg(hash)
            .arg("--")
            .arg(file);
        match run_git_command(app_handle,
                              window_label.as_str(),
                              task,
                              command,
                              RESULT_LABEL,
                              |h, wl, o| {
                                  let message = EmitMessage {
                                      is_ok: true,
                                      result: &o,
                                  };
                                  post_git_command_result(h, wl, &message, RESULT_LABEL);
                              },
        ).await {
            Ok(output) => {}
            Err(e) => {}
        }
    });

    Ok(())
}

#[command]
async fn git_show_file_diff_cancel(window_label: String) {
    cancel_task(GIT_SHOW_FILE_DIFF_COMMAND, window_label).await;
}

// tauri commandでウィンドウ生成する場合、asyncにしなければwindowsでデッドロックが起きる
// (https://tauri.app/v1/guides/features/multiwindow/)
#[command]
async fn open_new_window(app_handle: AppHandle, hash: String, x: f64, y: f64) {
    // タイムスタンプを使って一意のウィンドウ識別子を生成
    let start = SystemTime::now();
    let since_the_epoch = start.duration_since(UNIX_EPOCH).expect("Time went backwards");
    let unique_id = since_the_epoch.as_millis();

    let new_window_label = format!("new_window_{}", unique_id); // 一意の識別子を設定

    let new_window = tauri::WindowBuilder::new(
        &app_handle,
        &new_window_label,
        WindowUrl::App("/src/commit_info_window.html".into()),
    )
        .title(&hash)
        // .decorations(false)
        // .position(x, y)
        .inner_size(800., 600.)
        .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu --disable-local-storage --disable-background-networking --kiosk --disable-context-menu --single-process")
        .build()
        .unwrap();

    // ウィンドウのuseEffect実行を待機するためのイベントをリッスン
    let app_handle_clone = app_handle.clone();
    new_window.listen("ready-to-receive", move |event| {
        if let Some(window_label) = event.payload() {
            println!("open new window: {}", window_label);
            let window_label = window_label.trim_matches('"');
            app_handle_clone.app_handle()
                .emit_to(window_label, "commit-hash", hash.clone())
                .unwrap();
        }
    });
}

#[derive(Serialize)]
struct BranchInfo {
    branch_name: String,
    branch_state: BranchState,
}

const GIT_BRANCH_COMMAND: &str = "git_branch";

#[command]
async fn git_branch(app_handle: AppHandle, window_label: String) -> Result<(), String> {
    // 実行中かどうかをチェック
    if is_running_command(GIT_BRANCH_COMMAND, window_label.clone()).await {
        return Err("The command is running".to_string());
    }

    const RESULT_LABEL: &str = "post-git-branch-result";

    // CancellationTokenをクローンして非同期タスクに渡す
    let task = create_task(GIT_BRANCH_COMMAND, window_label.clone()).await;

    tokio::spawn(async move {
        let mut binding = Command::new("git");
        let command = binding
            .kill_on_drop(true)
            .arg("branch")
            .arg("-a");
        match run_git_command(app_handle,
                              window_label.as_str(),
                              task,
                              command,
                              RESULT_LABEL,
                              |h, wl, o| {
                                  let res: Vec<BranchInfo> = o
                                      .lines()
                                      .filter(|line| !line.contains("remotes/origin/HEAD")) // HEADは除外
                                      .map(|line| {
                                          let mut state: BranchState = BranchState::Default;
                                          if line.starts_with("* ") {
                                              state = BranchState::Current;
                                          }

                                          let branch_name = line[2..].to_string();

                                          if branch_name.starts_with("remotes/") {
                                              state = BranchState::Remote;
                                          }

                                          BranchInfo {
                                              branch_name,
                                              branch_state: state,
                                          }
                                      })
                                      .collect();

                                  let message = EmitMessage {
                                      is_ok: true,
                                      result: &res,
                                  };
                                  post_git_command_result(h, wl, &message, RESULT_LABEL);
                              },
        ).await {
            Ok(output) => {}
            Err(e) => {}
        }
    });

    Ok(())
}

#[command]
async fn git_branch_cancel(window_label: String) {
    cancel_task(GIT_BRANCH_COMMAND, window_label).await;
}

const GIT_BRANCH_CREATE_COMMAND: &str = "git_branch_create";

#[command]
async fn git_branch_create(app_handle: AppHandle, window_label: String, new_branch_name: String) -> Result<(), String> {
    // 実行中かどうかをチェック
    if is_running_command(GIT_BRANCH_CREATE_COMMAND, window_label.clone()).await {
        return Err("The command is running".to_string());
    }

    const RESULT_LABEL: &str = "post-git-branch-create-result";

    // CancellationTokenをクローンして非同期タスクに渡す
    let task = create_task(GIT_BRANCH_CREATE_COMMAND, window_label.clone()).await;

    tokio::spawn(async move {
        let mut binding = Command::new("git");
        let command = binding
            .kill_on_drop(true)
            .arg("checkout")
            .arg("-b")
            .arg(&new_branch_name);
        match run_git_command(app_handle,
                              window_label.as_str(),
                              task,
                              command,
                              RESULT_LABEL,
                              |h, wl, o| {
                                  let message = EmitMessage {
                                      is_ok: true,
                                      result: &o,
                                  };
                                  post_git_command_result(h, wl, &message, RESULT_LABEL);
                              },
        ).await {
            Ok(output) => {}
            Err(e) => {}
        }
    });

    Ok(())
}

#[command]
async fn git_branch_create_cancel(window_label: String) {
    cancel_task(GIT_BRANCH_CREATE_COMMAND, window_label).await;
}

const GIT_BRANCH_DELETE_COMMAND: &str = "git_branch_delete";

#[command]
async fn git_branch_delete(app_handle: AppHandle, window_label: String, delete_branch_name: String) -> Result<(), String> {
    // 実行中かどうかをチェック
    if is_running_command(GIT_BRANCH_DELETE_COMMAND, window_label.clone()).await {
        return Err("The command is running".to_string());
    }

    const RESULT_LABEL: &str = "post-git-branch-delete-result";

    // CancellationTokenをクローンして非同期タスクに渡す
    let task = create_task(GIT_BRANCH_DELETE_COMMAND, window_label.clone()).await;

    tokio::spawn(async move {
        let mut binding = Command::new("git");
        let command = binding
            .kill_on_drop(true)
            .arg("branch")
            .arg("-d")
            .arg(&delete_branch_name);
        match run_git_command(app_handle,
                              window_label.as_str(),
                              task,
                              command,
                              RESULT_LABEL,
                              |h, wl, o| {
                                  let message = EmitMessage {
                                      is_ok: true,
                                      result: &o,
                                  };
                                  post_git_command_result(h, wl, &message, RESULT_LABEL);
                              },
        ).await {
            Ok(output) => {}
            Err(e) => {}
        }
    });

    Ok(())
}

#[command]
async fn git_branch_delete_cancel(window_label: String) {
    cancel_task(GIT_BRANCH_DELETE_COMMAND, window_label).await;
}

const GIT_BRANCH_CHECKOUT_COMMAND: &str = "git_branch_checkout";

#[command]
async fn git_branch_checkout(app_handle: AppHandle, window_label: String, checkout_branch_name: String) -> Result<(), String> {
    // 実行中かどうかをチェック
    if is_running_command(GIT_BRANCH_CHECKOUT_COMMAND, window_label.clone()).await {
        return Err("The command is running".to_string());
    }

    const RESULT_LABEL: &str = "post-git-branch-checkout-result";

    // CancellationTokenをクローンして非同期タスクに渡す
    let task = create_task(GIT_BRANCH_CHECKOUT_COMMAND, window_label.clone()).await;

    tokio::spawn(async move {
        let mut binding = Command::new("git");
        let command = binding
            .kill_on_drop(true)
            .arg("checkout")
            .arg(&checkout_branch_name);
        match run_git_command(app_handle,
                              window_label.as_str(),
                              task,
                              command,
                              RESULT_LABEL,
                              |h, wl, o| {
                                  println!("Success (git_branch_checkout): {}", o);

                                  let message = EmitMessage {
                                      is_ok: true,
                                      result: &"".to_string(),
                                  };
                                  post_git_command_result(h, wl, &message, RESULT_LABEL);
                              },
        ).await {
            Ok(output) => {}
            Err(e) => {}
        }
    });

    Ok(())
}

#[command]
async fn git_branch_checkout_cancel(window_label: String) {
    cancel_task(GIT_BRANCH_CHECKOUT_COMMAND, window_label).await;
}

const GIT_BRANCH_MERGE_COMMAND: &str = "git_branch_checkout";

#[command]
async fn git_branch_merge(app_handle: AppHandle, window_label: String, merge_branch_name: String) -> Result<(), String> {
    // 実行中かどうかをチェック
    if is_running_command(GIT_BRANCH_MERGE_COMMAND, window_label.clone()).await {
        return Err("The command is running".to_string());
    }

    const RESULT_LABEL: &str = "post-git-branch-merge-result";

    // CancellationTokenをクローンして非同期タスクに渡す
    let task = create_task(GIT_BRANCH_MERGE_COMMAND, window_label.clone()).await;

    tokio::spawn(async move {
        let mut binding = Command::new("git");
        let command = binding
            .kill_on_drop(true)
            .arg("merge")
            .arg(&merge_branch_name);
        match run_git_command(app_handle,
                              window_label.as_str(),
                              task,
                              command,
                              RESULT_LABEL,
                              |h, wl, o| {
                                  let message = EmitMessage {
                                      is_ok: true,
                                      result: &o,
                                  };
                                  post_git_command_result(h, wl, &message, RESULT_LABEL);
                              },
        ).await {
            Ok(output) => {}
            Err(e) => {}
        }
    });

    Ok(())
}

#[command]
async fn git_branch_merge_cancel(window_label: String) {
    cancel_task(GIT_BRANCH_MERGE_COMMAND, window_label).await;
}

const GIT_CHECKOUT_HASH_COMMAND: &str = "git_checkout_hash";

#[command]
async fn git_checkout_hash(app_handle: AppHandle, window_label: String, commit_hash: String) -> Result<(), String> {
    // 実行中かどうかをチェック
    if is_running_command(GIT_CHECKOUT_HASH_COMMAND, window_label.clone()).await {
        return Err("The command is running".to_string());
    }

    const RESULT_LABEL: &str = "post-git-checkout-hash-result";

    // CancellationTokenをクローンして非同期タスクに渡す
    let task = create_task(GIT_CHECKOUT_HASH_COMMAND, window_label.clone()).await;

    tokio::spawn(async move {
        let mut binding = Command::new("git");
        let command = binding
            .kill_on_drop(true)
            .arg("checkout")
            .arg(&commit_hash);
        match run_git_command(app_handle,
                              window_label.as_str(),
                              task,
                              command,
                              RESULT_LABEL,
                              |h, wl, o| {
                                  let message = EmitMessage {
                                      is_ok: true,
                                      result: &o,
                                  };
                                  post_git_command_result(h, wl, &message, RESULT_LABEL);
                              },
        ).await {
            Ok(output) => {}
            Err(e) => {}
        }
    });

    Ok(())
}

#[command]
async fn git_checkout_hash_cancel(window_label: String) {
    cancel_task(GIT_CHECKOUT_HASH_COMMAND, window_label).await;
}

#[command]
async fn is_on_branch(branch_name: String, branch_state: BranchState) -> Result<bool, String> {
    // `git symbolic-ref HEAD` コマンドを実行してHEADがブランチかどうかを確認
    let mut command = Command::new("git");
    command.arg("show-ref")
        .arg("--verify");
    if branch_state == BranchState::Remote {
        command.arg(format!("refs/{}", branch_name));
    } else {
        command.arg(format!("refs/heads/{}", branch_name));
    }

    let output = command.set_creation_flags()
        .output()
        .await
        .expect("Failed to execute git command");

    // コマンドの実行結果をチェック
    if output.status.success() {
        Ok(true)
    } else {
        // `git symbolic-ref HEAD` が失敗した場合、HEADはブランチではなくコミットハッシュを指している
        Ok(false)
    }
}

#[tokio::main]
async fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            git_status,
            git_status_cancel,
            git_diff,
            git_diff_cancel,
            git_commit,
            git_commit_cancel,
            git_discard_changes,
            git_discard_changes_adds_cancel,
            git_discard_changes_others_cancel,
            open_file_location,
            git_push,
            git_push_cancel,
            git_pull,
            git_pull_cancel,
            git_fetch,
            git_fetch_cancel,
            get_pull_push_count,
            get_pull_push_count_cancel,
            select_git_folder,
            get_git_folder,
            git_log,
            git_log_cancel,
            open_new_window,
            git_show,
            git_show_cancel,
            git_show_files,
            git_show_files_cancel,
            git_show_file_diff,
            git_show_file_diff_cancel,
            git_branch,
            git_branch_cancel,
            git_branch_create,
            git_branch_create_cancel,
            git_branch_delete,
            git_branch_delete_cancel,
            git_branch_checkout,
            git_branch_checkout_cancel,
            git_branch_merge,
            git_branch_merge_cancel,
            git_checkout_hash,
            git_checkout_hash_cancel,
            is_on_branch,
        ])
        .setup(|app| {
            if let Ok(path) = load_folder_path() {
                std::env::set_current_dir(path).expect("Failed to set current directory");
            }

            // "main" ウィンドウの取得
            let main_window = app.get_window("main").unwrap();

            // ウィンドウに window-shadows の装飾を適用
            #[cfg(any(windows, target_os = "macos"))]
            set_shadow(main_window, true).unwrap();

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
