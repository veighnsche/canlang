//! Retained input-owner association for checked-program lowering.

use super::Catalog;
use crate::diagnostic::Diagnostic;
use crate::source::{SourceDb, SourceId, Span};
use std::sync::Arc;

pub(super) struct CheckedCohort {
    db: Arc<()>,
    catalog: Option<Arc<()>>,
    files: Vec<SourceId>,
    source_count: usize,
}

impl CheckedCohort {
    pub(super) fn new(db: &SourceDb, files: &[SourceId], catalog: Option<&Catalog>) -> Self {
        Self {
            db: Arc::clone(db.identity()),
            catalog: catalog.map(|catalog| Arc::clone(catalog.identity())),
            files: files.to_vec(),
            source_count: db.len(),
        }
    }

    pub(super) fn files(&self) -> &[SourceId] {
        &self.files
    }

    pub(super) fn validate(
        &self,
        db: &SourceDb,
        catalog: Option<&Catalog>,
    ) -> Result<(), Diagnostic> {
        let mismatch = if !Arc::ptr_eq(&self.db, db.identity()) {
            Some("source database is a different owner from the checked program")
        } else if self
            .files
            .iter()
            .any(|id| id.0 as usize >= self.source_count)
        {
            // SourceId is public. A nonexistent selection must not become
            // checked merely because later appends eventually allocate that ID.
            Some("a selected source did not exist when the program was checked")
        } else if !match (&self.catalog, catalog) {
            (Some(checked), Some(supplied)) => Arc::ptr_eq(checked, supplied.identity()),
            (None, None) => true,
            _ => false,
        } {
            Some("producer catalog is a different owner from the checked program")
        } else {
            None
        };
        match mismatch {
            None => Ok(()),
            Some(reason) => Err(Diagnostic::error(
                "E6011",
                format!(
                    "checked input cohort mismatch: {reason}; recheck the supplied inputs before lowering"
                ),
                Span::new(db.iter().next().map_or(SourceId(0), |(id, _)| id), 0, 0),
            )),
        }
    }
}
