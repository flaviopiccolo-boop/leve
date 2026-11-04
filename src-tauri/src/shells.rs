use portable_pty::CommandBuilder;
use serde::Serialize;
use std::{env, path::{Path, PathBuf}};

#[derive(Serialize)]
pub struct ShellProfile {
    pub id: &'static str,
    pub name: &'static str,
    pub available: bool,
}

const PROFILES: [(&str, &str); 4] = [
    ("powershell", "PowerShell"), ("cmd", "CMD"),
    ("git-bash", "Git Bash"), ("pwsh", "PowerShell 7"),
];

fn on_path(name: &str) -> Option<PathBuf> {
    env::var_os("PATH").into_iter().flat_map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
        .map(|directory| directory.join(name)).find(|path| path.is_file())
}

fn in_folder(variable: &str, relative: &str) -> Option<PathBuf> {
    env::var_os(variable).map(|root| PathBuf::from(root).join(relative)).filter(|path| path.is_file())
}

fn executable(id: &str) -> Option<PathBuf> {
    match id {
        "powershell" => in_folder("SystemRoot", r"System32\WindowsPowerShell\v1.0\powershell.exe").or_else(|| on_path("powershell.exe")),
        "cmd" => in_folder("SystemRoot", r"System32\cmd.exe").or_else(|| on_path("cmd.exe")),
        "pwsh" => on_path("pwsh.exe").or_else(|| in_folder("ProgramFiles", r"PowerShell\7\pwsh.exe"))
            .or_else(|| in_folder("LOCALAPPDATA", r"Programs\PowerShell\7\pwsh.exe")),
        "git-bash" => on_path("git.exe").and_then(|git| git.parent()?.parent().map(|root| root.join(r"bin\bash.exe"))).filter(|path| path.is_file())
            .or_else(|| in_folder("ProgramFiles", r"Git\bin\bash.exe"))
            .or_else(|| in_folder("ProgramFiles(x86)", r"Git\bin\bash.exe"))
            .or_else(|| in_folder("LOCALAPPDATA", r"Programs\Git\bin\bash.exe"))
            .or_else(|| in_folder("LOCALAPPDATA", r"Git\bin\bash.exe"))
            .or_else(|| in_folder("USERPROFILE", r"scoop\apps\git\current\bin\bash.exe")),
        _ => None,
    }
}

#[tauri::command]
pub fn list_shells() -> Vec<ShellProfile> {
    PROFILES.iter().map(|&(id, name)| ShellProfile { id, name, available: executable(id).is_some() }).collect()
}

pub fn command(id: &str, root: &Path) -> Result<CommandBuilder, String> {
    let name = PROFILES.iter().find(|&&(profile, _)| profile == id).map(|&(_, name)| name)
        .ok_or_else(|| "Unknown terminal profile.".to_string())?;
    let executable = executable(id).ok_or_else(|| format!("{name} was not found. Install it and reopen the terminal menu."))?;
    let mut command = CommandBuilder::new(executable);
    match id {
        "powershell" | "pwsh" => { command.args(["-NoLogo", "-NoProfile", "-NoExit", "-Command", "$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)"]); }
        "cmd" => { command.args(["/D", "/K", "chcp 65001 >nul"]); }
        "git-bash" => {
            command.args(["--login", "-i"]);
            command.env("CHERE_INVOKING", "1");
        }
        _ => unreachable!(),
    }
    command.cwd(dunce::simplified(root));
    command.env("TERM", "xterm-256color");
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_profiles() {
        assert!(command("not-a-shell", Path::new(".")).is_err());
    }
}
