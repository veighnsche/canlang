# Models and relationships

A `Given` model declares stored records. Ownership may be app-wide, team-scoped, or contained under a parent model; choose the scope that matches who controls the data and which operation must be atomic. A contained child carries its parent relationship and shares the parent's storage owner. References preserve typed model identity and are checked for owner, lifetime, and expected version at admission.

```can
Given
 Project { name:text }
 Todo in Project { title:text trim, done:bool=false }
```

This fragment demonstrates a team-scoped `Project` and its contained tasks. Omitted model ownership means team; `in Project` creates an immutable implicit `parent:Project` relation. Use `Model in app` for app-scoped data. The fragment needs its policies and operations before it is a usable app. A reference field does not grant permission to read the referenced row. New references cannot target archived records; existing references can remain for authorized history. Unique constraints are checked at the storage owner and include retained rows until actual disposal.

Keep records that must change atomically under one owner. For durable owner coordination, see [transactions and concurrency](../05-Workflows/03-transactions-and-concurrency.md). Field omission, null, and validation rules belong to [defaults and validation](02-defaults-and-validation.md); history and disposal are in [history and retention](06-history-and-retention.md).
