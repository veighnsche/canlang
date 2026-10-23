//! Inline stderr presenter. The owner supplies snapshots and executes requested actions.
use crate::{
    input::{Action, Editor, HELP, InputResult},
    model::{Lifecycle, Snapshot},
    presentation::{self, bounded_history, terminal_text, wrap},
};
use ratatui::{
    Frame, Terminal, TerminalOptions, Viewport,
    backend::{Backend, ClearType, CrosstermBackend, WindowSize},
    buffer::Cell,
    crossterm::{
        cursor::Show,
        event::{self, DisableBracketedPaste, EnableBracketedPaste},
        execute,
        style::{Attribute, ResetColor, SetAttribute},
        terminal::{disable_raw_mode, enable_raw_mode, is_raw_mode_enabled},
    },
    layout::{Position, Rect, Size},
    style::{Color, Style},
    text::Line,
    widgets::{Paragraph, Widget},
};
use std::{
    io::{self, IsTerminal, Write},
    sync::mpsc::{Receiver, RecvTimeoutError, Sender},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Debug)]
pub enum UiUpdate {
    /// Complete verified owner snapshot; reconnects also use this variant.
    Snapshot(Snapshot),
    /// Owner-supplied retained diagnostics, captured excerpts, action results or logs.
    Message(Vec<String>),
    Disconnected(String),
    /// Forwarded by the process signal owner, including in plain mode.
    Interrupt,
    /// EOF or an explicit owner request to release this presentation only.
    Detach,
}

#[derive(Clone, Debug, Default)]
pub struct UiConfig {
    pub owned: bool,
    pub plain: bool,
    pub no_color: bool,
    /// Exact verified owner-specific recovery command, prepared by the controller.
    pub recovery_command: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExitReason {
    Stopped,
    Detached,
}

struct View {
    snapshot: Snapshot,
    connected: bool,
    outcome_id: Option<String>,
    editor: Editor,
    stop_requested: bool,
}

impl View {
    fn new(snapshot: Snapshot) -> Self {
        Self {
            snapshot,
            connected: true,
            outcome_id: None,
            editor: Editor::default(),
            stop_requested: false,
        }
    }

    fn adopt(&mut self, snapshot: Snapshot) -> Vec<String> {
        // A full snapshot is the resynchronization boundary; no delta reconstruction.
        if snapshot.schema != "can.dev.observation.v1"
            || snapshot.session != self.snapshot.session
            || snapshot.sequence < self.snapshot.sequence
        {
            return vec![
                "Ignored unverified or older observation; waiting for a verified owner snapshot."
                    .into(),
            ];
        }
        let mut history = Vec::new();
        if !self.connected {
            history.push("Control reconnected; verified snapshot received.".into());
        }
        self.connected = true;
        if snapshot.lifecycle != self.snapshot.lifecycle {
            history.push(format!(
                "Session {}.",
                presentation::lifecycle_label(snapshot.lifecycle)
            ));
        }
        if snapshot.shutdown_error != self.snapshot.shutdown_error
            && snapshot.shutdown_error.is_some()
        {
            history.push("Cleanup incomplete; retry stop through the owning session.".into());
        }
        if let Some(outcome) = &snapshot.last_outcome {
            if self.outcome_id.as_deref() != Some(outcome.id.as_str()) {
                self.outcome_id = Some(outcome.id.clone());
                history.extend(presentation::outcome(&snapshot));
            }
        }
        self.snapshot = snapshot;
        history
    }

    fn dispatch(
        &mut self,
        action: Action,
        config: &UiConfig,
        actions: &Sender<Action>,
        history: &mut Vec<String>,
    ) -> io::Result<Option<ExitReason>> {
        match action {
            Action::Detach if config.owned => history.push(
                "This view owns the session. Enter stop and wait for confirmed release.".into(),
            ),
            Action::Detach => return Ok(Some(ExitReason::Detached)),
            Action::Status => {
                history.push(presentation::identity(&self.snapshot, config.owned));
                history.extend(presentation::status(&self.snapshot, now(), self.connected));
                history.push(presentation::actions(
                    &self.snapshot,
                    config.owned,
                    self.connected,
                ));
            }
            Action::Stop if !config.owned => {
                history.push("Attached view cannot stop this owner. Enter detach to leave.".into())
            }
            _ => {
                // Admission is rechecked by the owning controller, including stale views.
                let stopping = action == Action::Stop;
                actions.send(action).map_err(|_| {
                    io::Error::new(io::ErrorKind::BrokenPipe, "Owner action channel closed")
                })?;
                if stopping {
                    self.stop_requested = true;
                }
            }
        }
        Ok(None)
    }

    fn interrupt(
        &mut self,
        config: &UiConfig,
        actions: &Sender<Action>,
        history: &mut Vec<String>,
    ) -> io::Result<Option<ExitReason>> {
        if !config.owned {
            return Ok(Some(ExitReason::Detached));
        }
        if self.stop_requested {
            history.push("Cleanup is still pending. Waiting for the owner; a failed cleanup can be retried with stop.".into());
            return Ok(None);
        }
        history.push("Stop requested; waiting for the owner to confirm resource release.".into());
        self.dispatch(Action::Stop, config, actions, history)
    }

    fn update(
        &mut self,
        update: UiUpdate,
        config: &UiConfig,
        actions: &Sender<Action>,
        history: &mut Vec<String>,
    ) -> io::Result<Option<ExitReason>> {
        match update {
            UiUpdate::Snapshot(snapshot) => {
                history.extend(self.adopt(snapshot));
                // A failed stop is retryable; the next interrupt must ask its owner again.
                if self.snapshot.lifecycle == Lifecycle::ShutdownIncomplete {
                    self.stop_requested = false;
                }
            }
            UiUpdate::Message(lines) => history.extend(bounded_history(&lines)),
            UiUpdate::Disconnected(reason) => {
                if self.connected {
                    history.push(format!(
                        "Control disconnected; session state unknown. {}",
                        terminal_text(&reason, 500)
                    ));
                }
                self.connected = false;
            }
            UiUpdate::Interrupt => return self.interrupt(config, actions, history),
            UiUpdate::Detach => return self.dispatch(Action::Detach, config, actions, history),
        }
        Ok(None)
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn final_lines(reason: ExitReason, view: &View, config: &UiConfig) -> Vec<String> {
    if reason == ExitReason::Stopped {
        return vec!["Stopped; owner confirmed resource release.".into()];
    }
    let mut lines = vec![if view.stop_requested {
        "Detached during cleanup; shutdown is unconfirmed.".into()
    } else {
        "Detached; session lifetime remains with its owner.".into()
    }];
    if config.owned {
        if let Some(command) = &config.recovery_command {
            lines.push(format!("Recovery: {}", terminal_text(command, 2000)));
        }
    }
    lines
}

/// Human output is exclusively stderr. Non-TTY and explicit plain mode never enable raw mode.
pub fn run(
    initial: Snapshot,
    updates: Receiver<UiUpdate>,
    actions: Sender<Action>,
    mut config: UiConfig,
) -> io::Result<ExitReason> {
    config.no_color |= std::env::var_os("NO_COLOR").is_some();
    let mut view = View::new(initial);
    let mut history = vec![
        presentation::identity(&view.snapshot, config.owned),
        terminal_text(&view.snapshot.source_path, 2000),
        HELP.into(),
    ];
    history.extend(view.adopt(view.snapshot.clone()));
    // Crossterm 0.29 cursor-position queries write to stdout even with a
    // stderr backend. Redirected stdout therefore selects append-only output.
    if config.plain
        || !io::stdin().is_terminal()
        || !io::stderr().is_terminal()
        || !io::stdout().is_terminal()
    {
        run_plain(&mut view, updates, actions, &config, history)
    } else {
        run_inline(&mut view, updates, actions, &config, history)
    }
}

fn write_lines(output: &mut impl Write, lines: &[String]) -> io::Result<()> {
    for line in lines {
        writeln!(output, "{}", terminal_text(line, 2000))?;
    }
    output.flush()
}

fn run_plain(
    view: &mut View,
    updates: Receiver<UiUpdate>,
    actions: Sender<Action>,
    config: &UiConfig,
    mut history: Vec<String>,
) -> io::Result<ExitReason> {
    let mut output = io::stderr().lock();
    let mut previous = String::new();
    loop {
        let key = presentation::transition_key(&view.snapshot, view.connected);
        if key != previous {
            history.extend(presentation::status(&view.snapshot, now(), view.connected));
            history.push(presentation::actions(
                &view.snapshot,
                config.owned,
                view.connected,
            ));
            previous = key;
        }
        write_lines(&mut output, &history)?;
        history.clear();
        if view.snapshot.lifecycle == Lifecycle::Stopped && view.connected {
            write_lines(&mut output, &final_lines(ExitReason::Stopped, view, config))?;
            return Ok(ExitReason::Stopped);
        }
        let update = match updates.recv_timeout(Duration::from_millis(100)) {
            Ok(update) => update,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                write_lines(
                    &mut output,
                    &["Owner observation channel closed; session state unknown.".into()],
                )?;
                write_lines(
                    &mut output,
                    &final_lines(ExitReason::Detached, view, config),
                )?;
                return Ok(ExitReason::Detached);
            }
        };
        if let Some(reason) = view.update(update, config, &actions, &mut history)? {
            history.extend(final_lines(reason, view, config));
            write_lines(&mut output, &history)?;
            return Ok(reason);
        }
    }
}

/// Restores the inherited raw-mode state on initialization failure, I/O error and unwind.
struct TerminalGuard {
    previous_raw: bool,
}
impl TerminalGuard {
    fn enter() -> io::Result<Self> {
        let guard = Self {
            previous_raw: is_raw_mode_enabled()?,
        };
        enable_raw_mode()?;
        execute!(io::stderr(), EnableBracketedPaste)?;
        Ok(guard)
    }
}
impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = execute!(
            io::stderr(),
            DisableBracketedPaste,
            Show,
            ResetColor,
            SetAttribute(Attribute::Reset)
        );
        if !self.previous_raw {
            let _ = disable_raw_mode();
        }
    }
}

/// This backend is used only by the inline stderr viewport. Ratatui clears the
/// whole visible screen on horizontal shrink; push that screen into physical
/// scrollback instead. Logical events are never replayed or synthesized here.
struct InlineStderrBackend(CrosstermBackend<io::Stderr>);
impl InlineStderrBackend {
    fn preserve_before_clear(&mut self) -> io::Result<()> {
        let size = self.0.size()?;
        if size.width == 0 || size.height == 0 {
            return Ok(());
        }
        self.0.set_cursor_position((0, size.height - 1))?;
        for _ in 0..size.height {
            self.0.write_all(b"\r\n")?;
        }
        // All previous visible rows are now in scrollback. Place a historical
        // marker directly after them, without overwriting a reflowed old row.
        self.0.set_cursor_position((0, 0))?;
        let label = "Above: historical view before resize.";
        self.0
            .write_all(&label.as_bytes()[..label.len().min(usize::from(size.width))])?;
        self.0.set_cursor_position((0, size.height - 1))?;
        self.0.write_all(b"\r\n")?;
        self.0.set_cursor_position((0, 0))?;
        Backend::flush(&mut self.0)
    }
}
impl Backend for InlineStderrBackend {
    type Error = io::Error;
    fn draw<'a, I>(&mut self, content: I) -> io::Result<()>
    where
        I: Iterator<Item = (u16, u16, &'a Cell)>,
    {
        self.0.draw(content)
    }
    fn hide_cursor(&mut self) -> io::Result<()> {
        self.0.hide_cursor()
    }
    fn show_cursor(&mut self) -> io::Result<()> {
        self.0.show_cursor()
    }
    fn get_cursor_position(&mut self) -> io::Result<Position> {
        self.0.get_cursor_position()
    }
    fn set_cursor_position<P: Into<Position>>(&mut self, position: P) -> io::Result<()> {
        self.0.set_cursor_position(position)
    }
    fn clear(&mut self) -> io::Result<()> {
        self.preserve_before_clear()
    }
    fn clear_region(&mut self, kind: ClearType) -> io::Result<()> {
        if kind == ClearType::All {
            self.preserve_before_clear()
        } else {
            self.0.clear_region(kind)
        }
    }
    fn append_lines(&mut self, count: u16) -> io::Result<()> {
        self.0.append_lines(count)
    }
    fn size(&self) -> io::Result<Size> {
        self.0.size()
    }
    fn window_size(&mut self) -> io::Result<WindowSize> {
        self.0.window_size()
    }
    fn flush(&mut self) -> io::Result<()> {
        Backend::flush(&mut self.0)
    }
    fn scroll_region_up(&mut self, region: std::ops::Range<u16>, count: u16) -> io::Result<()> {
        self.0.scroll_region_up(region, count)
    }
    fn scroll_region_down(&mut self, region: std::ops::Range<u16>, count: u16) -> io::Result<()> {
        self.0.scroll_region_down(region, count)
    }
}

fn append_history<B: Backend<Error = io::Error>>(
    terminal: &mut Terminal<B>,
    lines: &[String],
) -> io::Result<()> {
    terminal.autoresize()?;
    let width = terminal.size()?.width.max(1);
    let rendered: Vec<_> = lines.iter().flat_map(|line| wrap(line, width)).collect();
    // Small bounded insertions preserve scrollback even when a detail exceeds screen height.
    for chunk in rendered.chunks(64) {
        terminal.insert_before(chunk.len() as u16, |buffer| {
            Paragraph::new(
                chunk
                    .iter()
                    .map(|line| Line::raw(line.as_str()))
                    .collect::<Vec<_>>(),
            )
            .render(buffer.area, buffer);
        })?;
    }
    Ok(())
}

fn render(frame: &mut Frame<'_>, view: &View, config: &UiConfig) {
    let area = frame.area();
    if area.width == 0 || area.height == 0 {
        return;
    }
    let mut body = vec![presentation::identity(&view.snapshot, config.owned)];
    body.extend(presentation::status(&view.snapshot, now(), view.connected));
    let action_lines = wrap(
        &presentation::actions(&view.snapshot, config.owned, view.connected),
        area.width,
    );
    let reserved = (action_lines.len() as u16)
        .min(4)
        .min(area.height.saturating_sub(1));
    let body_height = area.height.saturating_sub(reserved + 1);
    let body_lines: Vec<_> = body
        .iter()
        .flat_map(|line| wrap(line, area.width))
        .collect();
    let mut visible: Vec<_> = body_lines
        .iter()
        .take(usize::from(body_height))
        .map(|line| {
            let style = if !config.no_color
                && (line.contains("incomplete")
                    || line.starts_with("Blocked:")
                    || line.starts_with("Result:"))
            {
                Style::default().fg(Color::LightRed)
            } else {
                Style::default()
            };
            Line::styled(line.clone(), style)
        })
        .collect();
    if body_lines.len() > usize::from(body_height) && body_height > 0 {
        visible[usize::from(body_height) - 1] = Line::raw("More captured status: details");
    }
    frame.render_widget(
        Paragraph::new(visible),
        Rect::new(area.x, area.y, area.width, body_height),
    );
    let action_y = area.y + body_height;
    frame.render_widget(
        Paragraph::new(
            action_lines
                .into_iter()
                .take(usize::from(reserved))
                .map(Line::raw)
                .collect::<Vec<_>>(),
        ),
        Rect::new(area.x, action_y, area.width, reserved),
    );
    let prompt_y = area.y + area.height - 1;
    let prefix = "can> ";
    let available = usize::from(area.width).saturating_sub(prefix.len() + 1);
    let value = view.editor.value();
    let tail = &value[value.len().saturating_sub(available)..]; // Editor accepts ASCII commands only.
    let prompt = format!("{prefix}{tail}");
    frame.render_widget(
        Paragraph::new(prompt.clone()),
        Rect::new(area.x, prompt_y, area.width, 1),
    );
    frame.set_cursor_position((area.x + (prompt.len() as u16).min(area.width - 1), prompt_y));
}

fn read_input(
    view: &mut View,
    config: &UiConfig,
    actions: &Sender<Action>,
    history: &mut Vec<String>,
) -> io::Result<Option<ExitReason>> {
    let mut exit = None;
    match view.editor.handle(event::read()?) {
        InputResult::Submit(line, action) if !line.trim().is_empty() => {
            history.push(format!("can> {line}"));
            if let Some(action) = action {
                exit = view.dispatch(action, config, &actions, history)?;
            } else {
                history.push("Unknown command. Enter help for known commands.".into());
            }
        }
        InputResult::Interrupt => exit = view.interrupt(config, &actions, history)?,
        InputResult::End => exit = view.dispatch(Action::Detach, config, actions, history)?,
        InputResult::RejectedPaste => history
            .push("Paste containing newlines or controls ignored. Enter one known command.".into()),
        _ => {}
    }
    Ok(exit)
}

fn run_inline(
    view: &mut View,
    updates: Receiver<UiUpdate>,
    actions: Sender<Action>,
    config: &UiConfig,
    mut history: Vec<String>,
) -> io::Result<ExitReason> {
    let _guard = TerminalGuard::enter()?;
    let backend = InlineStderrBackend(CrosstermBackend::new(io::stderr()));
    let mut terminal = Terminal::with_options(
        backend,
        TerminalOptions {
            viewport: Viewport::Inline(18),
        },
    )?;
    loop {
        append_history(&mut terminal, &history)?;
        history.clear();
        terminal.draw(|frame| render(frame, view, config))?;
        let mut exit = if view.snapshot.lifecycle == Lifecycle::Stopped && view.connected {
            Some(ExitReason::Stopped)
        } else {
            None
        };
        if exit.is_none() && event::poll(Duration::from_millis(30))? {
            exit = read_input(view, config, &actions, &mut history)?;
        }
        // Bound each batch so a busy build/log producer cannot starve command input.
        for _ in 0..8 {
            if exit.is_some() {
                break;
            }
            match updates.try_recv() {
                Ok(update) => exit = view.update(update, config, &actions, &mut history)?,
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    history.push("Owner observation channel closed; session state unknown.".into());
                    exit = Some(ExitReason::Detached);
                }
            }
        }
        if let Some(reason) = exit {
            history.extend(final_lines(reason, view, config));
            append_history(&mut terminal, &history)?;
            terminal.clear()?;
            terminal.show_cursor()?;
            return Ok(reason);
        }
    }
}
