use super::*;

pub(super) struct ServiceWorker {
    pub(super) resources: Arc<sdk::Resources>,
    pub(super) bridge: Arc<Bridge>,
    pub(super) command: String,
    pub(super) payload: Value,
    pub(super) capture: Option<Capture>,
    pub(super) index: Option<Arc<ConstructIndex>>,
    pub(super) recipe: Option<Arc<Recipe>>,
    pub(super) original: Option<Value>,
    pub(super) base: Value,
    pub(super) run: Option<String>,
    pub(super) files: Arc<Mutex<Vec<Payloads>>>,
}
impl ServiceWorker {
    pub(super) fn run(self, cancel: &AtomicBool) -> ServiceFact {
        let current = self
            .capture
            .as_ref()
            .is_none_or(|c| self.current(c, cancel, false));
        let result = self.perform(cancel, current);
        let post_current = self
            .capture
            .as_ref()
            .is_none_or(|c| self.current(c, cancel, false));
        ServiceFact {
            result,
            current: current && post_current,
            recipe: self.recipe,
            run: self.run,
            held: self.files,
        }
    }
    fn perform(&self, cancel: &AtomicBool, current: bool) -> Result<Value> {
        match self.command.as_str() {
            "audit" => Ok(Value::Null),
            "preview.open" => {
                let mut value = self.base.clone();
                value["actors"] = self.base["actors"].clone();
                Ok(value)
            }
            "recovery" => {
                let mut payload = self.payload["recovery"].clone();
                payload["cron"] = json!("can-resource-recovery");
                let result = sdk::call(
                    &self.bridge,
                    &self.resources,
                    "mf.scheduled",
                    self.payload["build"].as_str(),
                    payload,
                    cancel,
                )
                .map_err(native_error)?;
                if result["outcome"] != "ok" {
                    return Err(error(
                        "RUNTIME_RECOVERY_FAILED",
                        "local resource recovery failed",
                    ));
                }
                Ok(result)
            }
            "example.run" if !current => Err(error(
                "REVISION_CONFLICT",
                "example run requires the current admitted build",
            )),
            "example.run" | "example.rerun" => self.examples(cancel),
            _ => self.construct(cancel, current),
        }
    }
    fn inventory(&self, cancel: &AtomicBool) -> std::result::Result<Inventory, String> {
        let c = self.capture.as_ref().ok_or("capture unavailable")?;
        if c.input_inventory.as_deref() != Some("installed-local-preview") {
            return Ok(Inventory {
                package_input_paths: vec![],
                extra_input_paths: vec![],
            });
        }
        let compiler = c
            .inputs
            .iter()
            .find(|i| i.name == "compiler")
            .and_then(|i| i.canonical_path.as_ref())
            .ok_or("compiler path unavailable")?;
        let catalog = c
            .inputs
            .iter()
            .find(|i| i.name == "catalog")
            .and_then(|i| i.canonical_path.as_ref());
        let call = |command: &str, parent: Option<&str>, payload: Value, signal: &AtomicBool| {
            sdk::call(
                &self.bridge,
                &self.resources,
                command,
                parent,
                payload,
                signal,
            )
        };
        inventory::collect(
            std::path::Path::new(&c.root),
            std::path::Path::new(compiler),
            std::path::Path::new(catalog.ok_or("catalog unavailable")?),
            &call,
            cancel,
        )
    }

    fn current(&self, c: &Capture, cancel: &AtomicBool, runtime: bool) -> bool {
        let inventory = || self.inventory(cancel);
        if runtime {
            capture::runtime_inputs_current(c, &inventory, cancel)
        } else {
            capture::is_current(c, &inventory, cancel)
        }
    }
    fn construct(&self, cancel: &AtomicBool, current: bool) -> Result<Value> {
        let revision = self.payload["revision"].as_str().unwrap_or("");
        let session = self.payload["session"].as_str().unwrap_or("");
        let current = current && self.payload["current"] == true;
        if self.command == "construct.rank" && !current {
            return Ok(
                json!({"schema":"can.dev.construct-rank.v1","session":session,"revision":revision,"index_revision":self.index.as_ref().map(|i|i.value["index_revision"].clone()),"result":{"state":"stale","reason":"source or help revision changed"}}),
            );
        }
        let Some(index) = &self.index else {
            if self.command == "diagnostic.detail" {
                return Ok(self.base.clone());
            }
            if self.command == "construct.rank" {
                return Ok(
                    json!({"schema":"can.dev.construct-rank.v1","session":session,"revision":revision,"index_revision":null,"result":{"state":"candidate_coverage_unknown","reason":"captured help or producer inputs are unavailable"}}),
                );
            }
            return Err(error(
                "HELP_UNAVAILABLE",
                "captured construct help is unavailable",
            ));
        };
        let (payloads, mut payload) = self.construct_payload()?;
        payload["index"] = json!(index.reference);
        self.files
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(payloads);
        let result = construct::run(
            self.capture
                .as_ref()
                .ok_or_else(|| error("CAPTURE_UNAVAILABLE", "capture unavailable"))?,
            &payload,
            cancel,
        )
        .map_err(native_error)?;
        let source = self.capture.as_ref().map(|c| c.source_revision.clone());
        match self.command.as_str() {
            "diagnostic.detail" => {
                let mut base = self.base.clone();
                base["construct_help"] = result["construct_help"].clone();
                Ok(base)
            }
            "construct.rank" => Ok(
                json!({"schema":"can.dev.construct-rank.v1","session":session,"revision":revision,"index_revision":index.value["index_revision"],"result":result["result"]}),
            ),
            _ => {
                if result["card"].is_null() {
                    return Err(error(
                        "CONSTRUCT_UNKNOWN",
                        "construct ID is not in captured help",
                    ));
                }
                Ok(
                    json!({"schema":"can.dev.construct-help.v1","session":session,"revision":revision,"source_revision":source,"index_revision":index.value["index_revision"],"current":current,"card":result["card"],"candidate_coverage":"unknown"}),
                )
            }
        }
    }
    fn construct_payload(&self) -> Result<(Payloads, Value)> {
        let mut files = Payloads::new().map_err(|e| error("CAPTURE_UNAVAILABLE", e))?;
        let capture = files
            .json(
                self.capture
                    .as_ref()
                    .ok_or_else(|| error("REVISION_UNAVAILABLE", "capture unavailable"))?,
            )
            .map_err(|e| error("CAPTURE_UNAVAILABLE", e))?;
        let action = match self.command.as_str() {
            "diagnostic.detail" => "detail",
            "construct.rank" => "rank",
            _ => "help",
        };
        let payload = json!({"capture":capture,"action":action,"id":self.payload["id"],"candidates":self.payload["diagnostic"]["construct_candidates"],"diagnostic":self.payload["diagnostic"],"complete":self.payload["complete"],"omitted":self.payload["omitted"],"authorIntent":self.payload["authorIntent"]});
        Ok((files, payload))
    }
    fn examples(&self, cancel: &AtomicBool) -> Result<Value> {
        let rerun = self.command == "example.rerun";
        let original = self.original.as_ref().and_then(|o| o.get("original"));
        if self.original.as_ref().is_some_and(|o| o["expired"] == true) {
            return Ok(service::rerun_refusal("failure_unavailable", original));
        }
        let Some(recipe) = self.recipe.as_ref() else {
            return Ok(service::rerun_refusal("artifact_unavailable", original));
        };
        let run = self.run.as_deref().unwrap_or("");
        if !self.current(&recipe.capture, cancel, true) {
            if rerun {
                return Ok(service::rerun_refusal("resource_unavailable", original));
            }
            return Err(error(
                "CAPTURE_CHANGED",
                "captured example runtime inputs changed; stop and restart this session",
            ));
        }
        let result = self.run_examples(recipe, run, cancel);
        let result = match result {
            Ok(v) => v,
            Err(e) if rerun && e.code != "CLEANUP_REQUIRED" && !cancel.load(Ordering::Acquire) => {
                return Ok(service::rerun_refusal(
                    if e.code == "CAPTURE_CHANGED" {
                        "resource_unavailable"
                    } else {
                        "rerun_incomplete"
                    },
                    original,
                ));
            }
            Err(e) => return Err(e),
        };
        if !self.current(&recipe.capture, cancel, true) {
            if rerun {
                return Ok(service::rerun_refusal("resource_unavailable", original));
            }
            return Err(error(
                "CAPTURE_CHANGED",
                "captured example runtime inputs changed; stop and restart this session",
            ));
        }
        if rerun {
            return self.rerun_result(&result, recipe, run);
        }
        Ok(
            json!({"schema":"can.dev.example-run.v1","session":self.payload["session"],"revision":recipe.revision,"source_revision":recipe.capture.source_revision,
            "serving_build":recipe.build,"artifact_digest":recipe.digest,"run_id":run,"current":true,"ok":result["ok"],"executed":result["executed"],"summary":result["report"]["summary"],
            "projections":result["projections"],"private_result":result,"replay":{"available":false,"reason":"no_restore_capsule"}}),
        )
    }
    fn run_examples(&self, recipe: &Recipe, run: &str, cancel: &AtomicBool) -> Result<Value> {
        let session = self.payload["session"].as_str().unwrap_or("");
        let context = failure_context(session, &recipe.revision, &recipe.capture, &recipe.build);
        let selected = if self.command == "example.rerun" {
            self.original.as_ref().map(|v| v["selector"].clone())
        } else if self.payload.get("operation").is_some() {
            Some(json!({"operation":self.payload["operation"],"rowIndex":self.payload["rowIndex"]}))
        } else {
            None
        };
        let parent = request_id("example-sdk");
        let call = |command: &str, scope: Option<&str>, payload: Value, signal: &AtomicBool| {
            sdk::call(
                &self.bridge,
                &self.resources,
                command,
                scope,
                payload,
                signal,
            )
        };
        let inventory = || self.inventory(cancel);
        let outcome = examples::run(
            &recipe.value,
            &recipe.capture,
            &parent,
            run,
            selected.as_ref(),
            Some(&context),
            &inventory,
            &call,
            cancel,
        );
        sdk::release(&self.bridge, &self.resources, &parent).map_err(native_error)?;
        let result = outcome.map_err(native_error)?;
        if result["artifactDigest"] != recipe.digest
            || result["report"]["artifact"]["digest"] != recipe.digest
            || result["report"]["artifact"]["sourceRevision"] != recipe.capture.source_revision
        {
            return Err(error(
                "EXAMPLES_UNAVAILABLE",
                "example report differs from the admitted artifact",
            ));
        }
        Ok(result)
    }
    fn rerun_result(&self, result: &Value, recipe: &Recipe, run: &str) -> Result<Value> {
        let record = self.original.as_ref().unwrap_or(&Value::Null);
        let original = record.get("original");
        let Some(row) = service::one_row(
            result,
            &record["selector"],
            &recipe.digest,
            &recipe.capture.source_revision,
        ) else {
            return Ok(service::rerun_refusal("rerun_incomplete", original));
        };
        if row["outcome"] == "unsupported" {
            let mut value = service::rerun_refusal("row_unsupported", original);
            value["rerun"] = service::attempt(result, run, row);
            return Ok(value);
        }
        Ok(
            json!({"schema":"can.dev.example-rerun.v1","ok":true,"kind":"isolated_example_rerun","original":original,"rerun":service::attempt(result,run,row),
            "artifact":{"artifactRef":recipe.build,"revision":recipe.revision,"sourceRevision":recipe.capture.source_revision,"artifactDigest":recipe.digest},
            "inputs":{"unchanged":["artifact_bytes","source_revision","worker_modules","fixture_recipe_id","runtime_profile_id"],"changed":["run_id","D1_row_scope","Identity_accounts_and_sessions"],"unknown":["ambient_time","generated_random_values","external_resource_state"]},
            "replay":{"available":false,"reason":"no_restore_capsule"},"evidence":{"missing":["actor_projection_unavailable","runtime_detail_unreleased","trace_unavailable"]},"projections":result["projections"],"private_result":result}),
        )
    }
}
