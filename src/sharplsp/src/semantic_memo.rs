//! The one memo of semantic answers: hover, definition, type definition,
//! declaration, references and document highlights. Implements [HOVER-CACHING],
//! [DEFINITION-CACHE] and [REFERENCES-SALSA].
//!
//! Only Salsa keeps an answer. A question is an input: its document, version,
//! position and method. The workspace generation is the other input, and it
//! moves on any document edit or close, a solution or target-framework switch,
//! a compiler workspace change and a compiler respawn, because an answer can
//! point into any file. Invalidation is a counter bump that never waits behind
//! a running compiler request; the next question applies it.
//!
//! This mirrors `lspkit_server::pull::PullStore`, which memoizes diagnostics
//! only. A memo for any request belongs in `lspkit-server`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use anyhow::Result;
use salsa::Setter;
use serde_json::Value;

/// Questions kept before the database is replaced, so hovering across a large
/// file cannot grow the input table for the host's whole life.
const QUESTION_LIMIT: usize = 4096;

/// What a question is asked about; the memo's identity for one answer.
#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub struct Key {
    /// The document the position is in.
    pub uri: String,
    /// The request method, with any option that changes the answer.
    pub method: &'static str,
    /// Zero-based line of the position.
    pub line: u32,
    /// Zero-based character of the position.
    pub character: u32,
}

/// One computed answer and whether it may be reused.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Outcome {
    /// The LSP result; `null` when the compiler could not answer.
    value: Arc<Value>,
    /// Empty, unsettled and failed answers are asked again next time.
    keep: bool,
}

/// The compiler round trip of the question being answered: its LSP result and
/// whether that result is settled.
type Ask = Box<dyn FnOnce() -> Result<(Value, bool)> + Send>;

/// The execution context of the query in flight; never a second result store.
#[derive(Default)]
struct Flight {
    /// The round trip, taken by the query on a miss and left in place by a hit.
    ask: Option<Ask>,
    /// The round trip's own failure, returned to the caller instead of memoized.
    failure: Option<anyhow::Error>,
}

#[salsa::db]
/// The database surface a query needs: run the round trip in flight.
trait SemanticDb: salsa::Database {
    /// Run the round trip of the question being answered.
    fn ask(&self) -> Outcome;
}

#[salsa::db]
#[derive(Clone)]
/// Owns the memo storage and the round trip of the query in flight.
struct Database {
    /// Salsa's memo storage; no parallel map of answers exists.
    storage: salsa::Storage<Self>,
    /// The query in flight.
    flight: Arc<Mutex<Flight>>,
}

#[salsa::db]
impl salsa::Database for Database {}

#[salsa::db]
impl SemanticDb for Database {
    fn ask(&self) -> Outcome {
        let mut flight = self.flight.lock().unwrap_or_else(PoisonError::into_inner);
        let asked = flight.ask.take().map(|ask| ask());
        match asked {
            Some(Ok((value, settled))) => Outcome {
                keep: settled && !is_empty(&value),
                value: Arc::new(value),
            },
            Some(Err(error)) => {
                flight.failure = Some(error);
                unanswered()
            }
            None => unanswered(),
        }
    }
}

/// The answer of a round trip that did not happen or failed: never reused.
fn unanswered() -> Outcome {
    Outcome {
        value: Arc::new(Value::Null),
        keep: false,
    }
}

#[salsa::input]
/// Everything outside the asked document that an answer depends on.
struct Workspace {
    generation: u64,
}

#[salsa::input]
/// One question; its handle is reused so a repeat is a memo hit.
struct Question {
    version: i32,
    retry: u64,
}

#[salsa::tracked(returns(clone))]
fn answer(db: &dyn SemanticDb, question: Question, workspace: Workspace) -> Outcome {
    let _generation = workspace.generation(db);
    let _version = question.version(db);
    let _retry = question.retry(db);
    db.ask()
}

/// The database with its input handles; dropped whole to release them.
struct State {
    /// The memo database.
    database: Database,
    /// The workspace generation input.
    workspace: Workspace,
    /// Reusable question inputs; handles only, never answers.
    questions: HashMap<Key, Question>,
}

impl State {
    /// An empty database at `generation`.
    fn new(generation: u64) -> Self {
        let database = Database {
            storage: salsa::Storage::default(),
            flight: Arc::default(),
        };
        let workspace = Workspace::new(&database, generation);
        Self {
            database,
            workspace,
            questions: HashMap::new(),
        }
    }

    /// Apply the pending generation and the document's version, then return
    /// the question's input.
    fn sync(&mut self, key: &Key, version: i32, generation: u64) -> Question {
        if *self.workspace.generation(&self.database) != generation {
            let _previous = self
                .workspace
                .set_generation(&mut self.database)
                .to(generation);
        }
        let question = *self
            .questions
            .entry(key.clone())
            .or_insert_with(|| Question::new(&self.database, version, 0));
        if *question.version(&self.database) != version {
            let _previous = question.set_version(&mut self.database).to(version);
        }
        question
    }

    /// Answer `key`, running `ask` only on a miss. The flag is whether the memo
    /// answered without it.
    fn answer(
        &mut self,
        key: &Key,
        version: i32,
        generation: u64,
        ask: Ask,
    ) -> Result<(Value, bool)> {
        let question = self.sync(key, version, generation);
        self.flight().ask = Some(ask);
        let outcome = answer(&self.database, question, self.workspace);
        let (unused, failure) = {
            let mut flight = self.flight();
            (flight.ask.take(), flight.failure.take())
        };
        if !outcome.keep {
            let next = question.retry(&self.database).wrapping_add(1);
            let _previous = question.set_retry(&mut self.database).to(next);
        }
        failure.map_or_else(|| Ok((Value::clone(&outcome.value), unused.is_some())), Err)
    }

    /// The query in flight; a poisoned lock still holds a usable context.
    fn flight(&self) -> std::sync::MutexGuard<'_, Flight> {
        self.database
            .flight
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

/// The memo of one connection.
pub struct Memo {
    /// The database; one question is answered at a time.
    state: Mutex<State>,
    /// Bumped without waiting for the database; applied by the next question.
    generation: AtomicU64,
}

impl Default for Memo {
    fn default() -> Self {
        Self {
            state: Mutex::new(State::new(1)),
            generation: AtomicU64::new(1),
        }
    }
}

impl Memo {
    /// Every memoized answer is stale: an input outside its question changed.
    pub fn invalidate(&self) {
        let _previous = self.generation.fetch_add(1, Ordering::AcqRel);
    }

    /// The generation an answer is computed under.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    /// Drop every input and answer. Salsa inputs cannot be deleted one by one,
    /// so the database is replaced. [REFERENCES-SALSA]
    pub fn release(&self) {
        self.invalidate();
        let replacement = State::new(self.generation());
        let previous = std::mem::replace(&mut *self.state(), replacement);
        drop(previous);
    }

    /// Answer `key` at the document's `version`, running `ask` only when the
    /// memo has no current answer. The flag is whether the memo answered.
    ///
    /// # Errors
    /// The round trip's own failure, which is never memoized.
    pub fn answer(&self, key: &Key, version: i32, ask: Ask) -> Result<(Value, bool)> {
        let mut state = self.state();
        if state.questions.len() >= QUESTION_LIMIT {
            *state = State::new(self.generation());
        }
        let generation = self.generation();
        state.answer(key, version, generation, ask)
    }

    /// How many questions the memo holds answers or inputs for.
    #[cfg(test)]
    pub fn held(&self) -> usize {
        self.state().questions.len()
    }

    /// The database; a poisoned lock still holds a consistent database, since
    /// a query that panicked recorded no answer.
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The connection's memo.
static MEMO: OnceLock<Memo> = OnceLock::new();

/// The connection's memo, created on first use.
pub fn memo() -> &'static Memo {
    MEMO.get_or_init(Memo::default)
}

/// Whether an answer is empty: `null` or `[]`. An empty answer means "the
/// compiler had nothing yet", never "definitively nothing" — the memo and the
/// cross-language fallback both ask again. [GitHub #110]
pub fn is_empty(value: &Value) -> bool {
    value.is_null() || value.as_array().is_some_and(Vec::is_empty)
}

#[cfg(test)]
#[path = "semantic_memo_tests.rs"]
mod tests;
