//! Bounded command editing; only an explicit Enter dispatches a known action.
use ratatui::crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
use serde_json::Value;

pub const HELP: &str = "Enter check (c), open/access (o), details (d), status (s), help (h/?), logs (l), stop (owned) or detach (attached). Use diagnostics, diagnostic.detail, failures, failure.lookup/detail, construct.help/rank, rank.lookup, example.run/rerun or preview.status with their JSON command flags. No shell commands.";
const MAX_INPUT: usize = 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Action {
    Check,
    Open,
    Details,
    Status,
    Help,
    Logs,
    Stop,
    Detach,
    Control { command: String, payload: Value },
}

impl Action {
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value.trim().to_ascii_lowercase().as_str() {
            "check" | "c" => Self::Check,
            "open" | "access" | "o" => Self::Open,
            "details" | "d" => Self::Details,
            "status" | "s" => Self::Status,
            "help" | "h" | "?" => Self::Help,
            "logs" | "l" => Self::Logs,
            "stop" => Self::Stop,
            "detach" | "quit" => Self::Detach,
            _ => return Self::control(value),
        })
    }

    fn control(value: &str) -> Option<Self> {
        let (command, intent) = value
            .split_once(" --author-intent ")
            .map_or((value, None), |(command, intent)| (command, Some(intent)));
        let mut argv: Vec<String> = command.split_whitespace().map(str::to_owned).collect();
        if let Some(intent) = intent {
            argv.extend(["--author-intent".into(), intent.into()]);
        }
        let args = crate::cli::parse(&argv).ok()?;
        if !matches!(
            args.command.as_str(),
            "diagnostics"
                | "diagnostic.detail"
                | "failures"
                | "failure.lookup"
                | "failure.detail"
                | "construct.help"
                | "construct.rank"
                | "rank.lookup"
                | "example.run"
                | "example.rerun"
                | "preview.status"
        ) || ["--root", "--session", "--app", "--profile"]
            .iter()
            .any(|flag| args.value(flag).is_some())
        {
            return None;
        }
        Some(Self::Control {
            payload: crate::cli::payload(&args),
            command: args.command,
        })
    }
}

#[derive(Debug, Eq, PartialEq)]
pub enum InputResult {
    None,
    Submit(String, Option<Action>),
    Interrupt,
    End,
    RejectedPaste,
}

#[derive(Default)]
pub struct Editor {
    value: String,
}

impl Editor {
    pub fn value(&self) -> &str {
        &self.value
    }

    pub fn handle(&mut self, event: Event) -> InputResult {
        match event {
            Event::Paste(text) => {
                // Never interpret pasted newlines, controls, or escape sequences as keys.
                if text.chars().any(char::is_control) {
                    return InputResult::RejectedPaste;
                }
                let remaining = MAX_INPUT.saturating_sub(self.value.len());
                self.value
                    .extend(text.chars().filter(char::is_ascii).take(remaining));
            }
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                if key.modifiers.contains(KeyModifiers::CONTROL) {
                    match key.code {
                        KeyCode::Char('c') => return InputResult::Interrupt,
                        KeyCode::Char('d') if self.value.is_empty() => return InputResult::End,
                        KeyCode::Char('u') => self.value.clear(),
                        _ => {}
                    }
                    return InputResult::None;
                }
                match key.code {
                    KeyCode::Enter => {
                        let line = std::mem::take(&mut self.value);
                        let action = Action::parse(&line);
                        return InputResult::Submit(line, action);
                    }
                    KeyCode::Backspace => {
                        self.value.pop();
                    }
                    KeyCode::Char(ch) if ch.is_ascii_graphic() || ch == ' ' => {
                        if self.value.len() < MAX_INPUT
                            && !key.modifiers.contains(KeyModifiers::ALT)
                        {
                            self.value.push(ch);
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        InputResult::None
    }
}
