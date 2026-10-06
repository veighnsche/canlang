# Consultations and uncertainty

## Reused package ownership advice

The package options remain the same semantic owners, three grouped domains, or one runtime package. The original three equivalent consultations below are reused only for this ownership recommendation. They do not settle new correctness or workflow requirements.

## JEV consultation evidence

The difficult package-boundary choice was consulted using `tools/jev.py`, question type `choice`, with three independently worded equivalent contexts, questions and criteria. A preserves useful semantic packages and consolidates duplicated behavior; B groups runtime producers into three domains; C groups runtime producers into one package with subpaths. Each option is assessed against consumers, migration cost, workflows, authority, simplicity and dependency reachability; no option assumes unmeasured performance/safety gains. No extra services/sidecars/IPC/adapters are allowed.

| Request | Selected | Confidence | P(A) | P(B) | P(C) | Model | Input/output tokens |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | A | 0.75 | 0.84 | 0.16 | 0.00 | jev-1.13.0 | 776 / 38 |
| 2 | A | 0.84 | 0.90 | 0.06 | 0.04 | jev-1.13.0 | 745 / 38 |
| 3 | A | 0.95 | 0.96 | 0.04 | 0.00 | jev-1.13.0 | 783 / 38 |

All three selected A; probability/confidence variation is preserved rather than presented as certainty. There was no choice disagreement to investigate. Later source review further identified production imports reaching Node-only service test harnesses, reinforcing the need to fix ownership and transitive imports instead of relying on package count. The initial sandboxed connection attempt failed before a result; network-authorized calls used the same first request and two fresh variants, with no automatic caller retries. Advice does not decide unresolved localization semantics or authorize the refactor.

<details>
<summary>Full request and response 1</summary>

```json
{
  "request": {
    "state": "Canlang checkout 99195148 has 12 TypeScript workspaces, one Rust compiler crate and Python research tools. Root Bun installs packages/* once; root builds contracts/cloudflare/testkit and values join, while producer-specific TS builds and Node test runners remain. values supplies stdlib, compiler catalog JSON and conformance; ui/identity are consumed by interfaces and workerd tests. Cloudflare CLI hosts emitted JS using state, interfaces, identity and ui; Rust compiles and communicates through existing artifact/catalog and CLI contracts. state, work, files and services represent storage/invocation, durable work, uploads and provider bindings; contracts is shared authority-neutral protocol; testkit is tooling. stdlib currently assembles values only. Source duplicates exist in values vs ui ICU/locale formatting, forms vs controls field rendering, provider adapters validation owned by mail, state D1/DO codec/predicate helpers and testkit vs services scenario validation (services version depends on Node Buffer). No performance, safety, release or install benefit of merging or adding another language port was measured. Historical lanes explain inconsistent build/export shapes, but ownership/authority responsibilities are real. Small apps remain .can; independent drafts gitlink and frozen evidence remain. Compare effort, cognitive load, compatibility, full workflows and dependency/runtime reachability fairly; services/sidecars/IPC/adapters solely for language boundaries are excluded. This is documentation only; a grouped-package migration may disrupt public imports, compiler runtime specifiers, artifact loader, pack list and conformance fixtures.",
    "questions": {
      "layout": {
        "type": "choice",
        "instructions": "Which package layout is best justified for the deferred desired tree by these verified consumers and ownership constraints?",
        "criteria": {
          "A": "Keep current semantic package owners, consolidate duplicated implementations into their existing neutral owners, and align build/install/export wiring at a later implementation step; split private responsibilities within packages.",
          "B": "Group runtime producer workspaces into three packages (pure values; state/work/files/services runtime; identity/interfaces/ui presentation), retain contracts/platform/testkit tooling, and move tests and import/build/pack callers together.",
          "C": "Consolidate runtime producers into one runtime package with named subdirectories/subpath exports, retain contracts/platform/testkit tooling, and migrate all consumers and build/pack wiring together."
        }
      }
    },
    "model": "jev-latest"
  },
  "response": {
    "model": "jev-1.13.0",
    "answers": {
      "layout": {
        "type": "choice",
        "choice": "A",
        "confidence": 0.75,
        "probabilities": {
          "A": 0.84,
          "B": 0.16,
          "C": 0.0
        }
      }
    },
    "usage": {
      "input_tokens": 776,
      "output_tokens": 38
    }
  }
}
```

</details>

<details>
<summary>Full request and response 2</summary>

```json
{
  "request": {
    "state": "At revision 99195148 the Canlang source contains a Rust compilation crate, Python utilities, and twelve TS packages installed by a single root Bun workspace. Root checking/emission covers the integration owners plus values, and the remaining semantic producers still have individual checking/testing commands and divergent source-versus-dist interfaces. Real consumers include the values stdlib/catalog/conformance join, interfaces consuming authentication and UI, browser tests embedding their dist trees, and platform loading compiler artifacts into a worker with invocation/storage and interface dependencies. The responsibilities are established: authority-neutral contracts, pure values, owner-local state transactions, durable work, files, external providers, authentication, protocol interfaces, presentation, deployment/local-host tooling, and test runner tooling. stdlib only wraps values at present. Some algorithms are duplicated: UI and values localization, overlapping forms/control primitives, general provider-result checking located in mail, storage SQL/row helpers across D1 and DO, and playback validation repeated to avoid Node Buffer in Workers. Build divergence comes from lane history. The current artifacts and CLI already bridge Rust/JS; extra processes, IPC and language-driven wrappers are outside scope. No measurements establish faster/safer execution or cheaper installation from reducing package count. Source layout work is postponed and must keep permissions, evaluation order, fixture semantics, .can ownership, independent draft repository and frozen audit history intact. Repackaging affects package specifiers/exports, emitted imports, loader trees, manifests, release packs and tests.",
    "questions": {
      "layout": {
        "type": "choice",
        "instructions": "Given the documented dependency graph and migration costs, select the most supportable target organization for this living research plan.",
        "criteria": {
          "A": "Preserve the existing responsibility-based workspaces; remove duplicate algorithm ownership at existing neutral producers and later make their build/export integration consistent, with internal decomposition as needed.",
          "B": "Adopt three producer groups for values, durable execution plus providers/files, and authentication plus interfaces/rendering; retain shared protocols and platform/test tools separately, updating every dependent path as a unit.",
          "C": "Use one runtime workspace with responsibility folders and explicit exported subpaths, while keeping shared contracts and platform/testing tools apart; change all downstream imports and release/build instructions in the migration."
        }
      }
    },
    "model": "jev-latest"
  },
  "response": {
    "model": "jev-1.13.0",
    "answers": {
      "layout": {
        "type": "choice",
        "choice": "A",
        "confidence": 0.84,
        "probabilities": {
          "B": 0.06,
          "C": 0.04,
          "A": 0.9
        }
      }
    },
    "usage": {
      "input_tokens": 745,
      "output_tokens": 38
    }
  }
}
```

</details>

<details>
<summary>Full request and response 3</summary>

```json
{
  "request": {
    "state": "Evidence from Canlang commit 99195148: twelve JavaScript/TypeScript workspaces are installed together with Bun, alongside a single Rust compiler and Python syntax/evaluation tools. Only the integration packages and the values join participate in the root build; producers use separate TS build/typecheck and Node tests, sometimes exporting source rather than built files. These packages are not unused mirrors: values feeds standard functions, a Rust-consumed JSON catalog and fixture comparisons; UI and identity feed interfaces and actual local worker journeys; cloudflare assembles emitted handlers with state and interface/auth/rendering pieces. Shared contracts, values, owner state, durable jobs, files, provider clients, identity, interfaces, UI, stdlib, platform and testkit have documented owners. The thin stdlib is values-only for now. The strongest repeated logic appears in ICU/locale behavior, form/control field representations, completion checks incorrectly housed in mail, common SQL and codecs in D1/DO, and scenario validation duplicated for Worker portability because the services implementation imports node:buffer. An earlier lane structure caused fragmented install/build/export conventions. Merging might simplify package integration, but published import stability, producer testing, artifact loading, generated runtime imports and pack definitions are affected and benefits are not measured. We must conserve product and storage authority distinctions, app composition in Can, draft gitlink ownership and historical evidence. No new service, sidecar, IPC boundary or language-accommodation adapter is acceptable. Compare the three options on supported workflows, maintenance/change burden, author simplicity and token-efficient navigation without assuming speed/safety gains.",
    "questions": {
      "layout": {
        "type": "choice",
        "instructions": "Which deferred tree choice follows most closely from this evidence while keeping the change scope proportionate?",
        "criteria": {
          "A": "Leave useful package responsibility boundaries in place, share the known duplicate logic through its natural existing owner, standardize producer wiring later, and partition large files by actual private responsibilities.",
          "B": "Collapse producer boundaries into a pure-values group, a state/work/files/providers group and an identity/interfaces/UI group, preserving separate contracts and platform/testkit and migrating the affected consumers/tests/builds.",
          "C": "Place all production runtime domains in one package with internal directories and public subpath modules, leaving contracts and platform/testkit separate and adapting emitted imports, tests, loaders and release wiring."
        }
      }
    },
    "model": "jev-latest"
  },
  "response": {
    "model": "jev-1.13.0",
    "answers": {
      "layout": {
        "type": "choice",
        "choice": "A",
        "confidence": 0.95,
        "probabilities": {
          "C": 0.0,
          "A": 0.96,
          "B": 0.04
        }
      }
    },
    "usage": {
      "input_tokens": 783,
      "output_tokens": 38
    }
  }
}
```

</details>

## Current workflow advice and concurrent correction

Saved T28 containment, T31 staged hooks, T32 checkpoint fence, description/reference and historical T33 fanout requests/results remain in their owning `design/jev/` or `implementation/challenge-audit-run/evidence/jev-*` directories. Their question/choice/result shapes were decoded; this audit made no new external call.

The initial T33 A/B/A (.27/.19/.20) results used incomplete companion context. During this audit, [corrected context](../../design/jev/t33-context-correction-20261006/README.md) and [resolution](../../implementation/challenge-audit-run/t33-resolution.md) appeared as an untracked overlay. Direct draft source/companion reads corroborate finite complete cohorts and child isolation/progress; three corrected equivalent requests select A (.88/.93/.97). Supporting intent is not execution or certified direct human authorship. Preserve old advice and new uncertainty; ratified handoff/incorporation and concrete membership/checkpoint/recovery producers remain pending. Do not describe visibly rejecting bounded overflow as silent failure, infer unanimous rejection from low probabilities, or ask for a population estimate merely to preserve the declared outcome.

Package grouping advice does not decide browser proof, atomic identity/fence protocol, semantic locale profile sharing or precise fanout storage/API. Those are named gates; a new consequential policy choice requires verified balanced alternatives and the repository three-request protocol before selection.
