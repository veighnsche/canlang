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

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::crossterm::event::KeyEvent;

    fn key(code: KeyCode) -> Event {
        Event::Key(KeyEvent::new(code, KeyModifiers::NONE))
    }

    #[test]
    fn aliases_require_enter_and_unknown_text_has_no_action() {
        let mut editor = Editor::default();
        assert_eq!(editor.handle(Event::Paste("c".into())), InputResult::None);
        assert_eq!(editor.value(), "c");
        assert_eq!(
            editor.handle(key(KeyCode::Enter)),
            InputResult::Submit("c".into(), Some(Action::Check))
        );
        editor.handle(Event::Paste("rm -rf /".into()));
        assert_eq!(
            editor.handle(key(KeyCode::Enter)),
            InputResult::Submit("rm -rf /".into(), None)
        );
        assert_eq!(Action::parse(" ACCESS "), Some(Action::Open));
    }

    #[test]
    fn explicit_owner_actions_reuse_json_validation_and_never_change_selection() {
        assert_eq!(
            Action::parse("example.run --expected-revision r2 --operation App.save --row 0"),
            Some(Action::Control {
                command: "example.run".into(),
                payload: serde_json::json!({"expectedRevision":"r2","operation":"App.save","rowIndex":0})
            })
        );
        assert_eq!(
            Action::parse(
                "construct.rank --revision r2 --index 0 --author-intent Prefer a concise table"
            ),
            Some(Action::Control {
                command: "construct.rank".into(),
                payload: serde_json::json!({"revision":"r2","index":0,"authorIntent":"Prefer a concise table"})
            })
        );
        for command in [
            "start --source Other.can",
            "stop --session foreign",
            "diagnostics --revision r2 --root /other",
            "example.run",
            "diagnostic.detail --revision r1 --index -1",
            "failures --revision r1; rm -rf /",
        ] {
            assert_eq!(Action::parse(command), None, "{command}");
        }
        assert!(Action::parse("failure.detail --ref session/r2/run/f0_1").is_some());
        assert!(Action::parse("construct.help --revision r1 --id can.v1.ui.table").is_some());
    }

    #[test]
    fn multiline_and_control_paste_never_dispatch_or_corrupt_typed_input() {
        let mut editor = Editor::default();
        editor.handle(Event::Paste("sta".into()));
        for pasted in ["check\nstop", "check\rstop", "\u{3}", "\x1b[31m"] {
            assert_eq!(
                editor.handle(Event::Paste(pasted.into())),
                InputResult::RejectedPaste
            );
            assert_eq!(editor.value(), "sta");
        }
        editor.handle(Event::Resize(44, 24));
        assert_eq!(editor.value(), "sta");
        editor.handle(Event::Paste("tus".into()));
        assert_eq!(
            editor.handle(key(KeyCode::Enter)),
            InputResult::Submit("status".into(), Some(Action::Status))
        );
    }

    #[test]
    fn editing_is_bounded_and_release_does_not_submit() {
        let mut editor = Editor::default();
        editor.handle(Event::Paste("x".repeat(5000)));
        assert_eq!(editor.value().len(), MAX_INPUT);
        editor.handle(key(KeyCode::Backspace));
        assert_eq!(editor.value().len(), MAX_INPUT - 1);
        let release =
            KeyEvent::new_with_kind(KeyCode::Enter, KeyModifiers::NONE, KeyEventKind::Release);
        assert_eq!(editor.handle(Event::Key(release)), InputResult::None);
    }
}
