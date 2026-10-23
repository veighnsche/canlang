# Complete selected target tree

Reconciled to source `8d48f969`: 3,809 pinned parent paths plus twelve substantive audit review documents, with the `draft` gitlink expanded to its 951 independently owned inputs (4,771 file leaves). The added review documents do not change the product pin. Every current leaf is retained at its exact path. Previously selected private extractions and the dev policy integration are implemented; their actual defining files now appear as current leaves. The obsolete Cloudflare executor is excluded and its retirement remains recorded in [port assessment](port-assessment.md). No further package, process or broad monolith split is selected. Remaining semantic corrections and unreviewed workflows have explicit tasks/gates rather than speculative target filenames. Ignored caches, credentials and worktrees remain outside scope.

```text
canlang/
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── release.yml
├── compiler/
│   ├── src/
│   │   ├── analysis/
│   │   │   ├── types/
│   │   │   │   └── given.rs
│   │   │   ├── catalog.rs
│   │   │   ├── check.rs
│   │   │   ├── cohort.rs
│   │   │   ├── effects.rs
│   │   │   ├── examples.rs
│   │   │   ├── generation.rs
│   │   │   ├── generation_config.rs
│   │   │   ├── generation_intake.rs
│   │   │   ├── generation_protocol.rs
│   │   │   ├── generation_store.rs
│   │   │   ├── icu.rs
│   │   │   ├── migrate_check.rs
│   │   │   ├── mod.rs
│   │   │   ├── resolve.rs
│   │   │   ├── scenario_disclosure.rs
│   │   │   └── types.rs
│   │   ├── cli/
│   │   │   ├── args.rs
│   │   │   ├── compile.rs
│   │   │   ├── entry.rs
│   │   │   ├── generation.rs
│   │   │   └── reference.rs
│   │   ├── codegen/
│   │   │   ├── js/
│   │   │   │   └── descriptors.rs
│   │   │   ├── artifact.rs
│   │   │   ├── authority_query_sites.rs
│   │   │   ├── bdd.rs
│   │   │   ├── defaults.rs
│   │   │   ├── event_decisions.rs
│   │   │   ├── event_notice_audit.rs
│   │   │   ├── event_send_decisions.rs
│   │   │   ├── invoice_collect_decisions.rs
│   │   │   ├── invoice_issue_decisions.rs
│   │   │   ├── ir.rs
│   │   │   ├── js.rs
│   │   │   ├── leave_decisions.rs
│   │   │   ├── mailbox_events.rs
│   │   │   ├── member_retry_decisions.rs
│   │   │   ├── membership.rs
│   │   │   ├── mod.rs
│   │   │   ├── model_policies.rs
│   │   │   ├── model_policy_profile.rs
│   │   │   ├── model_policy_sources.rs
│   │   │   ├── model_unique_conditions.rs
│   │   │   ├── payments_events.rs
│   │   │   ├── purchase_all.rs
│   │   │   ├── read_predicates.rs
│   │   │   ├── refer_decisions.rs
│   │   │   ├── rent_movement_refund_decisions.rs
│   │   │   ├── rent_notice_decisions.rs
│   │   │   ├── runtime_bindings.rs
│   │   │   ├── scenario_calls.rs
│   │   │   ├── scenario_create_sources.rs
│   │   │   ├── scenario_current_revision.rs
│   │   │   ├── scenario_decisions.rs
│   │   │   ├── scenario_feasibility.rs
│   │   │   ├── scenario_queries.rs
│   │   │   ├── scenario_receipts.rs
│   │   │   ├── send_guards.rs
│   │   │   ├── source_context.rs
│   │   │   ├── source_correspondence.rs
│   │   │   ├── source_created_rows.rs
│   │   │   ├── source_let_data.rs
│   │   │   ├── source_loops.rs
│   │   │   ├── source_send_data.rs
│   │   │   ├── sourcemap.rs
│   │   │   ├── standard_terminal_events.rs
│   │   │   ├── success_send_decisions.rs
│   │   │   ├── term_decisions.rs
│   │   │   └── then_views.rs
│   │   ├── ide/
│   │   │   ├── fixes.rs
│   │   │   ├── mod.rs
│   │   │   ├── queries.rs
│   │   │   ├── structure.rs
│   │   │   └── tokens.rs
│   │   ├── lint/
│   │   │   ├── driver.rs
│   │   │   ├── mod.rs
│   │   │   └── rules.rs
│   │   ├── lsp/
│   │   │   ├── mod.rs
│   │   │   ├── output.rs
│   │   │   ├── server.rs
│   │   │   ├── transport.rs
│   │   │   └── uri.rs
│   │   ├── syntax/
│   │   │   ├── construct_help.rs
│   │   │   ├── cst.rs
│   │   │   ├── layout.rs
│   │   │   ├── lexer.rs
│   │   │   ├── mod.rs
│   │   │   └── parser.rs
│   │   ├── cli.rs
│   │   ├── css_scope.rs
│   │   ├── diagnostic.rs
│   │   ├── docs.rs
│   │   ├── explain.rs
│   │   ├── format.rs
│   │   ├── json.rs
│   │   ├── leases.rs
│   │   ├── lib.rs
│   │   ├── main.rs
│   │   ├── policy.rs
│   │   └── source.rs
│   ├── tests/
│   │   ├── common/
│   │   │   └── lsp_driver.rs
│   │   ├── data/
│   │   │   ├── AuthoringDemo.can
│   │   │   └── s4_fix.can
│   │   ├── fixtures/
│   │   │   ├── action-references/
│   │   │   │   ├── execute.mjs
│   │   │   │   └── source.can
│   │   │   ├── completion-contract/
│   │   │   │   └── zsh.py
│   │   │   ├── corpus-admission/
│   │   │   │   ├── bare.can
│   │   │   │   ├── foreign.can
│   │   │   │   ├── judgment.can
│   │   │   │   ├── local.can
│   │   │   │   ├── missing.can
│   │   │   │   └── siblings.can
│   │   │   ├── decimal-runtime/
│   │   │   │   ├── execute.mjs
│   │   │   │   └── source.can
│   │   │   ├── invocation-references/
│   │   │   │   ├── execute.mjs
│   │   │   │   └── source.can
│   │   │   ├── operation-results/
│   │   │   │   └── source.can
│   │   │   ├── original-a850/
│   │   │   │   ├── CanChat.can
│   │   │   │   └── CanCreative.can
│   │   │   ├── affiliate-created-schedule.can
│   │   │   ├── affiliate-refresh-original.can
│   │   │   ├── agenda-workflow.can
│   │   │   ├── anonymous-message-consumer.mjs
│   │   │   ├── any-first-authenticated.can
│   │   │   ├── any-first-composition.can
│   │   │   ├── async_query_predicate.can
│   │   │   ├── book-available-source.can
│   │   │   ├── book-original-source.can
│   │   │   ├── bounded_query_rollback.can
│   │   │   ├── callback-diagnostics.can
│   │   │   ├── callback-probe.can
│   │   │   ├── cohort_trigger.can
│   │   │   ├── collection-call-consumer.mjs
│   │   │   ├── committed_change.can
│   │   │   ├── construct-help-first-profile.can
│   │   │   ├── contract-terminate-forwarded-reference.can
│   │   │   ├── created-contract-deployment.can
│   │   │   ├── crm-win-nullable-source.can
│   │   │   ├── declared-contract-send.can
│   │   │   ├── delete-control-consumer.mjs
│   │   │   ├── delivery-error-shapes-consumer.mjs
│   │   │   ├── delivery-error-shapes.can
│   │   │   ├── event-attendee-notice.can
│   │   │   ├── event-cancel-original-source.can
│   │   │   ├── event-change-retained.can
│   │   │   ├── event-register-source.can
│   │   │   ├── event-release-original-source.can
│   │   │   ├── expense-submit-original.can
│   │   │   ├── first-query-actor-guard.can
│   │   │   ├── first-query-conjunction-enum.can
│   │   │   ├── first-query-conjunction.can
│   │   │   ├── first-query-ifbranch-create.can
│   │   │   ├── first-query-member-withheld.can
│   │   │   ├── first-query-member.can
│   │   │   ├── first-query-navigation.can
│   │   │   ├── first-query-side-effect-absence.can
│   │   │   ├── first-query-side-effect-conjunction.can
│   │   │   ├── first-query-side-effect-private.can
│   │   │   ├── first-query-side-effect.can
│   │   │   ├── first-query-void-parent.can
│   │   │   ├── helper-entitlement-original.can
│   │   │   ├── helper-parent-reference-identity.can
│   │   │   ├── helper-reference-identity.can
│   │   │   ├── hook_order_contextual.can
│   │   │   ├── hook_order_rollback.can
│   │   │   ├── input_choices.can
│   │   │   ├── invoice-document-source-projection.can
│   │   │   ├── invoice-issue-owner-probe.can
│   │   │   ├── list-empty-consumer.mjs
│   │   │   ├── localized-format-consumer.mjs
│   │   │   ├── member-recheck-original-source.can
│   │   │   ├── model_reference_default.can
│   │   │   ├── native-ancestor-count.can
│   │   │   ├── native-authorization-can-use.can
│   │   │   ├── native-count-run-turn.can
│   │   │   ├── native-count-turn.can
│   │   │   ├── native-created-guarded-email.can
│   │   │   ├── native-data-egress-source.can
│   │   │   ├── native-enum-create-input.can
│   │   │   ├── native-first-budget.can
│   │   │   ├── native-first-count-run-turn.can
│   │   │   ├── native-first-replay.can
│   │   │   ├── native-require-missing-owner-frame.can
│   │   │   ├── native-three-query-run-turn.can
│   │   │   ├── nominal-preference-consumer.mjs
│   │   │   ├── original-partner-policy-closure.can
│   │   │   ├── preferences-then.can
│   │   │   ├── propose-document-derived-contract.can
│   │   │   ├── propose-handoff-original.can
│   │   │   ├── purchase-decision-source-require.can
│   │   │   ├── purchase-intake-source-require.can
│   │   │   ├── purchase-receive-all.can
│   │   │   ├── radial-progress-boundary.can
│   │   │   ├── rent-block-loop-source.can
│   │   │   ├── rent-booking-report-source.can
│   │   │   ├── rent-original-emission.can
│   │   │   ├── rent-prepare-branch-count.can
│   │   │   ├── rent-refund-evidence.can
│   │   │   ├── rent-restore-count-source.can
│   │   │   ├── row-history.can
│   │   │   ├── scalar-alias-overlaps.can
│   │   │   ├── scalar-table-filters.can
│   │   │   ├── scope-authority-int-filter-helpers.can
│   │   │   ├── scope-authority-int-filter.can
│   │   │   ├── scoped-contract-alias.can
│   │   │   ├── selected-call-consumer.mjs
│   │   │   ├── send-guard-reference-bound.can
│   │   │   ├── shift-accept-original.can
│   │   │   ├── shift-assign-original.can
│   │   │   ├── shift-cancel-original.can
│   │   │   ├── shift-decline-original.can
│   │   │   ├── shift-recover-original.can
│   │   │   ├── shift-request-original.can
│   │   │   ├── source-current-revision.can
│   │   │   ├── source-profile-scalars.can
│   │   │   ├── source-require-optional-customer.can
│   │   │   ├── source-row-consumer.mjs
│   │   │   ├── source-text-request.can
│   │   │   ├── source-transcript.can
│   │   │   ├── sourcemap-consumer.mjs
│   │   │   ├── state-machine-consumer.mjs
│   │   │   ├── static-page-title-consumer.mjs
│   │   │   ├── static_judgment.can
│   │   │   ├── std-nominal-field-reuse-consumer.mjs
│   │   │   ├── std-nominal-field-reuse.can
│   │   │   ├── stock-adjust-original.can
│   │   │   ├── table-filters.can
│   │   │   ├── table-order.can
│   │   │   ├── table-time.can
│   │   │   └── view-reuse.can
│   │   ├── action_references.rs
│   │   ├── actor_default_replay.rs
│   │   ├── actor_fact_bindings.rs
│   │   ├── admission_default_boundary.rs
│   │   ├── analysis.rs
│   │   ├── anonymous_actor_default_runtime.rs
│   │   ├── anonymous_message_bindings.rs
│   │   ├── anonymous_message_coverage.rs
│   │   ├── any_first_composition.rs
│   │   ├── array_concat_runtime.rs
│   │   ├── async_query_predicate_runtime.rs
│   │   ├── authoring.rs
│   │   ├── b1_join.rs
│   │   ├── b3_authoring_join.rs
│   │   ├── b3_i5.rs
│   │   ├── b3_migrate.rs
│   │   ├── b3_s4.rs
│   │   ├── b4_check.rs
│   │   ├── b4_examples.rs
│   │   ├── b4_parse.rs
│   │   ├── b4_resolve.rs
│   │   ├── b4_setparent.rs
│   │   ├── b4_witness.rs
│   │   ├── bare_row_actions.rs
│   │   ├── bdd_binding_runtime.rs
│   │   ├── bdd_checked_facts.rs
│   │   ├── bgi01_generation.rs
│   │   ├── bgi02_association.rs
│   │   ├── bgi03_config.rs
│   │   ├── bgi04_leases.rs
│   │   ├── bgi07_given.rs
│   │   ├── bgi0910_then.rs
│   │   ├── bgi11_validation.rs
│   │   ├── bgi12_controls.rs
│   │   ├── boolean_operation_admission.rs
│   │   ├── bound_producer_contracts.rs
│   │   ├── bound_tab_analysis.rs
│   │   ├── bounded_query_rollback_runtime.rs
│   │   ├── breadcrumb_context.rs
│   │   ├── calendar_agenda.rs
│   │   ├── callback_diagnostics.rs
│   │   ├── capability_event_handlers.rs
│   │   ├── catalog_input_contract.rs
│   │   ├── catalog_producer_runtime.rs
│   │   ├── check.rs
│   │   ├── checked_cohort.rs
│   │   ├── checked_query_facts.rs
│   │   ├── codegen.rs
│   │   ├── codegen_emit.rs
│   │   ├── cohort_trigger_runtime.rs
│   │   ├── collection_bool_filters.rs
│   │   ├── collection_calls.rs
│   │   ├── committed_change_runtime.rs
│   │   ├── compact_footer_codegen.rs
│   │   ├── completion_contract.rs
│   │   ├── composed_rule_owners.rs
│   │   ├── construct_help.rs
│   │   ├── contextual_state_read_composition.rs
│   │   ├── contract_runtime_kinds.rs
│   │   ├── corpus_admission.rs
│   │   ├── created_contract_census.rs
│   │   ├── created_scenario_result.rs
│   │   ├── cross_operation_calls.rs
│   │   ├── current_revision_definition_sources.rs
│   │   ├── cycle_witness.rs
│   │   ├── decimal_runtime.rs
│   │   ├── decision_source_facts.rs
│   │   ├── default_parameter_runtime.rs
│   │   ├── default_read_dependency.rs
│   │   ├── delete_control_runtime.rs
│   │   ├── delimiter_recovery.rs
│   │   ├── delivery_completion_handlers.rs
│   │   ├── delivery_error_shapes.rs
│   │   ├── delivery_field_runtime.rs
│   │   ├── delivery_progress_runtime.rs
│   │   ├── desk_derived_bool_runtime.rs
│   │   ├── desk_filter_profiles.rs
│   │   ├── details_drawer_runtime.rs
│   │   ├── direct_choice_alias_identity.rs
│   │   ├── dispatch_fence_persistence.rs
│   │   ├── docs.rs
│   │   ├── duration_codegen.rs
│   │   ├── effects.rs
│   │   ├── email_admission.rs
│   │   ├── empty_file_value_inventory.rs
│   │   ├── enum_default_runtime.rs
│   │   ├── enum_default_shapes.rs
│   │   ├── enum_filter_group.rs
│   │   ├── enum_handlers_runtime.rs
│   │   ├── enum_input_claim_runtime.rs
│   │   ├── enum_match_runtime.rs
│   │   ├── enum_member_create_input.rs
│   │   ├── enum_result_runtime.rs
│   │   ├── example_fixture_dependencies.rs
│   │   ├── example_operation_context.rs
│   │   ├── example_role_arrays.rs
│   │   ├── exe.rs
│   │   ├── factory_profiles.rs
│   │   ├── field_fragment_runtime.rs
│   │   ├── field_reuse_modifiers.rs
│   │   ├── file_ownership.rs
│   │   ├── file_profile_runtime.rs
│   │   ├── filter_remainder_pins.rs
│   │   ├── first_query_actor_guard.rs
│   │   ├── first_query_conjunction.rs
│   │   ├── first_query_ifbranch.rs
│   │   ├── first_query_side_effect.rs
│   │   ├── flat_expression_runtime.rs
│   │   ├── format.rs
│   │   ├── foundation.rs
│   │   ├── gallery_runtime.rs
│   │   ├── graph_width.rs
│   │   ├── hook_context_scope.rs
│   │   ├── hook_first_query.rs
│   │   ├── hook_hookrem.rs
│   │   ├── hook_lowering.rs
│   │   ├── hook_order_rollback_runtime.rs
│   │   ├── icu_profile.rs
│   │   ├── ide.rs
│   │   ├── input_choices.rs
│   │   ├── inspection_value_list.rs
│   │   ├── invocation_references.rs
│   │   ├── js_binding_runtime.rs
│   │   ├── json_input_contract.rs
│   │   ├── lint.rs
│   │   ├── list_empty_producer.rs
│   │   ├── localized_format.rs
│   │   ├── lsp_admission.rs
│   │   ├── lsp_frame_reader.rs
│   │   ├── lsp_typed_output.rs
│   │   ├── lsp_workspace.rs
│   │   ├── mailbox_source_producer.rs
│   │   ├── map_attribution.rs
│   │   ├── mcp_p1.rs
│   │   ├── mcp_p4.rs
│   │   ├── membership_calls.rs
│   │   ├── membership_codegen.rs
│   │   ├── membership_producer_bridge.rs
│   │   ├── message_slot_coverage.rs
│   │   ├── message_width.rs
│   │   ├── model_hook_profile.rs
│   │   ├── model_policy_current_revision.rs
│   │   ├── model_policy_producer.rs
│   │   ├── model_policy_profile.rs
│   │   ├── model_policy_required_paths.rs
│   │   ├── model_reference_default_runtime.rs
│   │   ├── model_rule_origins.rs
│   │   ├── model_unique_conditions.rs
│   │   ├── model_url_fields.rs
│   │   ├── money_defaults.rs
│   │   ├── native_ancestor_count.rs
│   │   ├── native_count_query.rs
│   │   ├── native_created_guarded_send.rs
│   │   ├── native_created_pair.rs
│   │   ├── native_dispatch_email_inputs.rs
│   │   ├── native_first_count_pair.rs
│   │   ├── native_first_query.rs
│   │   ├── native_first_replay.rs
│   │   ├── native_generation_receiving.rs
│   │   ├── native_guarded_send.rs
│   │   ├── native_profile_scalars.rs
│   │   ├── native_root_created_pair.rs
│   │   ├── native_scenario_receipts.rs
│   │   ├── native_three_query_pair.rs
│   │   ├── nominal_preference_runtime.rs
│   │   ├── nullable_url_link.rs
│   │   ├── operation_results.rs
│   │   ├── optional_object_fields.rs
│   │   ├── ordinary_contract_results.rs
│   │   ├── original_chat_model_policies.rs
│   │   ├── outbound_format_sinks.rs
│   │   ├── owning_source_inventory.rs
│   │   ├── parameter_array_bounds.rs
│   │   ├── payment_completion_handlers.rs
│   │   ├── payment_state_identity.rs
│   │   ├── payments_source_producer.rs
│   │   ├── persistence.rs
│   │   ├── persistence_review.rs
│   │   ├── policy_rebuild.rs
│   │   ├── predicate_reuse.rs
│   │   ├── preferences_placement.rs
│   │   ├── process_boundaries.rs
│   │   ├── qualified_enum_cases.rs
│   │   ├── query_native_runtime.rs
│   │   ├── query_order.rs
│   │   ├── query_source_producer.rs
│   │   ├── query_source_read_runtime.rs
│   │   ├── radial_progress_runtime.rs
│   │   ├── read_enum_default_runtime.rs
│   │   ├── read_grant_metadata.rs
│   │   ├── record_route_codegen.rs
│   │   ├── recurring_tick_handlers.rs
│   │   ├── released_leaf_controls.rs
│   │   ├── residual_profiles.rs
│   │   ├── resolved_default_replay.rs
│   │   ├── row_history.rs
│   │   ├── row_subject_policy.rs
│   │   ├── runtime_bindings.rs
│   │   ├── scenario_authorization_sources.rs
│   │   ├── scenario_call_defaults.rs
│   │   ├── scenario_call_references.rs
│   │   ├── scenario_contract_input_members.rs
│   │   ├── scenario_contract_snapshots.rs
│   │   ├── scenario_count_query_sources.rs
│   │   ├── scenario_created_inputs.rs
│   │   ├── scenario_current_revision_sources.rs
│   │   ├── scenario_disclosure.rs
│   │   ├── scenario_first_query_sources.rs
│   │   ├── scenario_inline_selection_sources.rs
│   │   ├── scenario_nested_any_query_sources.rs
│   │   ├── scenario_profile_sources.rs
│   │   ├── scenario_reference_model_results.rs
│   │   ├── scenario_transcript_sources.rs
│   │   ├── schedule_binding_runtime.rs
│   │   ├── scope_authority_reports.rs
│   │   ├── selected_app_locale.rs
│   │   ├── selected_calls.rs
│   │   ├── send_input_declarations.rs
│   │   ├── session_history.rs
│   │   ├── source_commands.rs
│   │   ├── sourcemap_contract.rs
│   │   ├── standard_completion_codegen.rs
│   │   ├── standard_completion_ir.rs
│   │   ├── standard_nominal_identity.rs
│   │   ├── standard_value_inventory.rs
│   │   ├── state_machines.rs
│   │   ├── static_judgment_runtime.rs
│   │   ├── static_page_titles.rs
│   │   ├── std_nominal_construct.rs
│   │   ├── std_nominal_equality.rs
│   │   ├── std_nominal_field_reuse.rs
│   │   ├── stored_query_profiles.rs
│   │   ├── stored_reference_source.rs
│   │   ├── string_payload_runtime.rs
│   │   ├── syntax.rs
│   │   ├── table_filters.rs
│   │   ├── table_order.rs
│   │   ├── table_row_children.rs
│   │   ├── table_time.rs
│   │   ├── teams_member_removed.rs
│   │   ├── temporal_message_types.rs
│   │   ├── text_message_value_list.rs
│   │   ├── toggle_form_control.rs
│   │   ├── typed_artifact.rs
│   │   ├── typed_artifact_consumer.rs
│   │   ├── typed_bdd.rs
│   │   ├── typed_descriptors.rs
│   │   ├── typed_diagnostics_cli.rs
│   │   ├── typed_explain.rs
│   │   ├── typed_fixes.rs
│   │   ├── typed_fixes_cli.rs
│   │   ├── typed_json.rs
│   │   ├── typed_policy.rs
│   │   ├── typed_reference_policy_consumers.rs
│   │   ├── typed_references.rs
│   │   ├── ui_adapter.rs
│   │   ├── ui_guard_narrowing.rs
│   │   ├── ui_original_bindings.rs
│   │   ├── user_default_replay.rs
│   │   ├── user_default_shapes.rs
│   │   ├── value_admission.rs
│   │   ├── value_query_order.rs
│   │   ├── view_reuse.rs
│   │   ├── width_boundaries.rs
│   │   └── workflow_fields.rs
│   ├── third-party-notices/
│   │   ├── THIRD-PARTY-NOTICES-aarch64-apple-darwin.txt
│   │   ├── THIRD-PARTY-NOTICES-x86_64-unknown-linux-gnu.txt
│   │   └── manifest.json
│   ├── .gitignore
│   ├── Cargo.lock
│   ├── Cargo.toml
│   ├── README.md
│   ├── build.rs
│   ├── can-completions.bash
│   ├── can-completions.fish
│   └── can-completions.zsh
├── dev-server/
│   ├── host/
│   │   ├── browser.mjs
│   │   ├── entry.mjs
│   │   ├── protocol.mjs
│   │   └── sdk.mjs
│   ├── src/
│   │   ├── browser_test/
│   │   │   └── browser.rs
│   │   ├── owner/
│   │   │   ├── check_worker.rs
│   │   │   └── service_worker.rs
│   │   ├── preview/
│   │   │   ├── analytics.js
│   │   │   ├── bindings.rs
│   │   │   ├── bundle.rs
│   │   │   ├── gateway.js
│   │   │   ├── http.rs
│   │   │   ├── runtime.rs
│   │   │   └── state.rs
│   │   ├── app.rs
│   │   ├── artifact.rs
│   │   ├── browser_test.rs
│   │   ├── capture.rs
│   │   ├── claim.rs
│   │   ├── cli.rs
│   │   ├── compiler.rs
│   │   ├── construct.rs
│   │   ├── control.rs
│   │   ├── examples.rs
│   │   ├── files.rs
│   │   ├── foreground.rs
│   │   ├── gateway.rs
│   │   ├── input.rs
│   │   ├── inventory.rs
│   │   ├── lib.rs
│   │   ├── main.rs
│   │   ├── model.rs
│   │   ├── owner.rs
│   │   ├── policy.rs
│   │   ├── presentation.rs
│   │   ├── preview.rs
│   │   ├── refusals.rs
│   │   ├── runtime.rs
│   │   ├── sdk.rs
│   │   ├── service.rs
│   │   ├── signals.rs
│   │   ├── state.rs
│   │   ├── test_support.rs
│   │   ├── ui.rs
│   │   └── watch.rs
│   ├── tests/
│   │   ├── integration/
│   │   │   ├── capture.rs
│   │   │   ├── claim.rs
│   │   │   ├── cli.rs
│   │   │   ├── compiler.rs
│   │   │   ├── construct.rs
│   │   │   ├── control.rs
│   │   │   ├── files.rs
│   │   │   ├── fixtures.rs
│   │   │   ├── inventory.rs
│   │   │   ├── refusals.rs
│   │   │   ├── runtime.rs
│   │   │   ├── terminal.rs
│   │   │   └── watch.rs
│   │   ├── boundaries.rs
│   │   ├── gateway.rs
│   │   ├── session_lifecycle.rs
│   │   └── state.rs
│   ├── third-party-notices/
│   │   ├── .gitattributes
│   │   ├── THIRD-PARTY-NOTICES.txt
│   │   └── manifest.json
│   ├── Cargo.lock
│   ├── Cargo.toml
│   ├── README.md
│   └── build.rs
├── docs/
│   ├── design/
│   │   ├── canonical-exposure-20261004/
│   │   │   ├── witness.can
│   │   │   └── witness.mjs
│   │   ├── complex-apps/
│   │   │   ├── chat-media.md
│   │   │   ├── decide.md
│   │   │   ├── discover.md
│   │   │   ├── enrich.md
│   │   │   ├── inbox.md
│   │   │   ├── knowledge.md
│   │   │   ├── sync.md
│   │   │   └── workbench.md
│   │   ├── evaluation/
│   │   │   ├── can-dev-generation-local-20261009/
│   │   │   │   └── README.md
│   │   │   ├── can-dev-help-comparison-20261009/
│   │   │   │   ├── PROTOCOL.md
│   │   │   │   ├── RESULTS.md
│   │   │   │   ├── cases.json
│   │   │   │   ├── run_rank_probe.py
│   │   │   │   └── score_rank_probe.py
│   │   │   ├── can-dev-novice-20261009/
│   │   │   │   ├── raw/
│   │   │   │   │   ├── expenses-luna.can
│   │   │   │   │   ├── expenses-sol.can
│   │   │   │   │   ├── shifts-luna.can
│   │   │   │   │   ├── shifts-sol.can
│   │   │   │   │   ├── supplies-luna.can
│   │   │   │   │   └── supplies-sol.can
│   │   │   │   └── findings.md
│   │   │   ├── evidence/
│   │   │   │   ├── adoption/
│   │   │   │   │   ├── economics/
│   │   │   │   │   │   ├── assumptions.md
│   │   │   │   │   │   └── model.py
│   │   │   │   │   ├── experiments/
│   │   │   │   │   │   ├── C/
│   │   │   │   │   │   │   ├── change-1/
│   │   │   │   │   │   │   │   ├── app.can
│   │   │   │   │   │   │   │   ├── notes.md
│   │   │   │   │   │   │   │   └── source.diff
│   │   │   │   │   │   │   ├── change-2/
│   │   │   │   │   │   │   │   ├── app.can
│   │   │   │   │   │   │   │   ├── notes.md
│   │   │   │   │   │   │   │   ├── source.diff
│   │   │   │   │   │   │   │   └── transition.md
│   │   │   │   │   │   │   ├── change-3/
│   │   │   │   │   │   │   │   ├── app.can
│   │   │   │   │   │   │   │   ├── notes.md
│   │   │   │   │   │   │   │   └── source.diff
│   │   │   │   │   │   │   ├── assumptions.md
│   │   │   │   │   │   │   ├── changes-context.md
│   │   │   │   │   │   │   ├── changes-notes.md
│   │   │   │   │   │   │   ├── initial.can
│   │   │   │   │   │   │   └── review-changes.md
│   │   │   │   │   │   ├── D/
│   │   │   │   │   │   │   ├── change-1/
│   │   │   │   │   │   │   │   ├── equipment/
│   │   │   │   │   │   │   │   │   ├── templates/
│   │   │   │   │   │   │   │   │   │   ├── equipment/
│   │   │   │   │   │   │   │   │   │   │   ├── base.html
│   │   │   │   │   │   │   │   │   │   │   ├── error.html
│   │   │   │   │   │   │   │   │   │   │   ├── form.html
│   │   │   │   │   │   │   │   │   │   │   ├── intake.html
│   │   │   │   │   │   │   │   │   │   │   ├── list.html
│   │   │   │   │   │   │   │   │   │   │   ├── token.html
│   │   │   │   │   │   │   │   │   │   │   └── upload.html
│   │   │   │   │   │   │   │   │   │   └── registration/
│   │   │   │   │   │   │   │   │   │       └── login.html
│   │   │   │   │   │   │   │   │   ├── __init__.py
│   │   │   │   │   │   │   │   │   ├── chat_auth.py
│   │   │   │   │   │   │   │   │   ├── forms.py
│   │   │   │   │   │   │   │   │   ├── mcp_server.py
│   │   │   │   │   │   │   │   │   ├── models.py
│   │   │   │   │   │   │   │   │   ├── service.py
│   │   │   │   │   │   │   │   │   ├── tests.py
│   │   │   │   │   │   │   │   │   ├── urls.py
│   │   │   │   │   │   │   │   │   └── views.py
│   │   │   │   │   │   │   │   ├── behavior.md
│   │   │   │   │   │   │   │   ├── requirements.txt
│   │   │   │   │   │   │   │   ├── test_settings.py
│   │   │   │   │   │   │   │   ├── transition.md
│   │   │   │   │   │   │   │   └── wiring.md
│   │   │   │   │   │   │   ├── change-2/
│   │   │   │   │   │   │   │   ├── equipment/
│   │   │   │   │   │   │   │   │   ├── templates/
│   │   │   │   │   │   │   │   │   │   ├── equipment/
│   │   │   │   │   │   │   │   │   │   │   ├── base.html
│   │   │   │   │   │   │   │   │   │   │   ├── error.html
│   │   │   │   │   │   │   │   │   │   │   ├── form.html
│   │   │   │   │   │   │   │   │   │   │   ├── intake.html
│   │   │   │   │   │   │   │   │   │   │   ├── list.html
│   │   │   │   │   │   │   │   │   │   │   ├── token.html
│   │   │   │   │   │   │   │   │   │   │   └── upload.html
│   │   │   │   │   │   │   │   │   │   └── registration/
│   │   │   │   │   │   │   │   │   │       └── login.html
│   │   │   │   │   │   │   │   │   ├── __init__.py
│   │   │   │   │   │   │   │   │   ├── chat_auth.py
│   │   │   │   │   │   │   │   │   ├── forms.py
│   │   │   │   │   │   │   │   │   ├── mcp_server.py
│   │   │   │   │   │   │   │   │   ├── models.py
│   │   │   │   │   │   │   │   │   ├── service.py
│   │   │   │   │   │   │   │   │   ├── tests.py
│   │   │   │   │   │   │   │   │   ├── urls.py
│   │   │   │   │   │   │   │   │   └── views.py
│   │   │   │   │   │   │   │   ├── behavior.md
│   │   │   │   │   │   │   │   ├── requirements.txt
│   │   │   │   │   │   │   │   ├── test_settings.py
│   │   │   │   │   │   │   │   ├── transition.md
│   │   │   │   │   │   │   │   ├── transition_operations.py
│   │   │   │   │   │   │   │   └── wiring.md
│   │   │   │   │   │   │   ├── change-3/
│   │   │   │   │   │   │   │   ├── equipment/
│   │   │   │   │   │   │   │   │   ├── templates/
│   │   │   │   │   │   │   │   │   │   ├── equipment/
│   │   │   │   │   │   │   │   │   │   │   ├── base.html
│   │   │   │   │   │   │   │   │   │   │   ├── detail.html
│   │   │   │   │   │   │   │   │   │   │   ├── error.html
│   │   │   │   │   │   │   │   │   │   │   ├── form.html
│   │   │   │   │   │   │   │   │   │   │   ├── intake.html
│   │   │   │   │   │   │   │   │   │   │   ├── list.html
│   │   │   │   │   │   │   │   │   │   │   ├── reviews.html
│   │   │   │   │   │   │   │   │   │   │   ├── token.html
│   │   │   │   │   │   │   │   │   │   │   └── upload.html
│   │   │   │   │   │   │   │   │   │   └── registration/
│   │   │   │   │   │   │   │   │   │       └── login.html
│   │   │   │   │   │   │   │   │   ├── __init__.py
│   │   │   │   │   │   │   │   │   ├── chat_auth.py
│   │   │   │   │   │   │   │   │   ├── forms.py
│   │   │   │   │   │   │   │   │   ├── mcp_server.py
│   │   │   │   │   │   │   │   │   ├── models.py
│   │   │   │   │   │   │   │   │   ├── service.py
│   │   │   │   │   │   │   │   │   ├── urls.py
│   │   │   │   │   │   │   │   │   └── views.py
│   │   │   │   │   │   │   │   ├── behavior.md
│   │   │   │   │   │   │   │   ├── permission-transition.md
│   │   │   │   │   │   │   │   ├── requirements.txt
│   │   │   │   │   │   │   │   ├── test_settings.py
│   │   │   │   │   │   │   │   ├── transition.md
│   │   │   │   │   │   │   │   ├── transition_operations.py
│   │   │   │   │   │   │   │   └── wiring.md
│   │   │   │   │   │   │   ├── initial/
│   │   │   │   │   │   │   │   ├── equipment/
│   │   │   │   │   │   │   │   │   ├── templates/
│   │   │   │   │   │   │   │   │   │   ├── equipment/
│   │   │   │   │   │   │   │   │   │   │   ├── base.html
│   │   │   │   │   │   │   │   │   │   │   ├── error.html
│   │   │   │   │   │   │   │   │   │   │   ├── form.html
│   │   │   │   │   │   │   │   │   │   │   ├── intake.html
│   │   │   │   │   │   │   │   │   │   │   ├── list.html
│   │   │   │   │   │   │   │   │   │   │   ├── token.html
│   │   │   │   │   │   │   │   │   │   │   └── upload.html
│   │   │   │   │   │   │   │   │   │   └── registration/
│   │   │   │   │   │   │   │   │   │       └── login.html
│   │   │   │   │   │   │   │   │   ├── __init__.py
│   │   │   │   │   │   │   │   │   ├── chat_auth.py
│   │   │   │   │   │   │   │   │   ├── forms.py
│   │   │   │   │   │   │   │   │   ├── mcp_server.py
│   │   │   │   │   │   │   │   │   ├── models.py
│   │   │   │   │   │   │   │   │   ├── service.py
│   │   │   │   │   │   │   │   │   ├── tests.py
│   │   │   │   │   │   │   │   │   ├── urls.py
│   │   │   │   │   │   │   │   │   └── views.py
│   │   │   │   │   │   │   │   ├── behavior.md
│   │   │   │   │   │   │   │   ├── requirements.txt
│   │   │   │   │   │   │   │   ├── test_settings.py
│   │   │   │   │   │   │   │   └── wiring.md
│   │   │   │   │   │   │   ├── assumptions.md
│   │   │   │   │   │   │   ├── changes-context.md
│   │   │   │   │   │   │   ├── changes-notes.md
│   │   │   │   │   │   │   ├── review-changes.md
│   │   │   │   │   │   │   └── review-initial.md
│   │   │   │   │   │   ├── layout/
│   │   │   │   │   │   │   ├── packages/
│   │   │   │   │   │   │   │   ├── after/
│   │   │   │   │   │   │   │   │   ├── CanExpense.can
│   │   │   │   │   │   │   │   │   ├── Employees.can
│   │   │   │   │   │   │   │   │   └── Locations.can
│   │   │   │   │   │   │   │   ├── before/
│   │   │   │   │   │   │   │   │   ├── CanExpense.can
│   │   │   │   │   │   │   │   │   ├── Employees.can
│   │   │   │   │   │   │   │   │   └── Locations.can
│   │   │   │   │   │   │   │   └── notes.md
│   │   │   │   │   │   │   ├── single/
│   │   │   │   │   │   │   │   ├── after/
│   │   │   │   │   │   │   │   │   └── ExpenseWorkspace.can
│   │   │   │   │   │   │   │   ├── before/
│   │   │   │   │   │   │   │   │   └── ExpenseWorkspace.can
│   │   │   │   │   │   │   │   └── notes.md
│   │   │   │   │   │   │   └── brief.md
│   │   │   │   │   │   ├── provider/
│   │   │   │   │   │   │   ├── CanMail.can
│   │   │   │   │   │   │   └── replacement.md
│   │   │   │   │   │   ├── assessment.md
│   │   │   │   │   │   ├── changes-brief.md
│   │   │   │   │   │   └── layout-assessment.md
│   │   │   │   │   ├── measurements/
│   │   │   │   │   │   ├── METHOD.md
│   │   │   │   │   │   ├── measure.py
│   │   │   │   │   │   └── measure_experiments.py
│   │   │   │   │   ├── consolidation.md
│   │   │   │   │   ├── experiment-protocol.md
│   │   │   │   │   ├── journeys.md
│   │   │   │   │   ├── methods.md
│   │   │   │   │   └── ownership.md
│   │   │   │   ├── interfaces/
│   │   │   │   │   ├── C-initial-review.md
│   │   │   │   │   ├── CanCRM-inline-caption.can
│   │   │   │   │   ├── TeamTasks-de-message-edit.can
│   │   │   │   │   ├── TeamTasks-de.can
│   │   │   │   │   ├── external-interface-facts.md
│   │   │   │   │   ├── inline-caption-experiment.py
│   │   │   │   │   ├── locale-experiment.py
│   │   │   │   │   ├── provider-facts.md
│   │   │   │   │   └── target-correspondence.md
│   │   │   │   └── language/
│   │   │   │       ├── alternatives.md
│   │   │   │       ├── experiment-c-review.md
│   │   │   │       ├── experiment-final-review.md
│   │   │   │       ├── findings.md
│   │   │   │       ├── rules.md
│   │   │   │       └── traces.md
│   │   │   ├── ADOPTION.md
│   │   │   ├── INTERFACES.md
│   │   │   ├── LANGUAGE.md
│   │   │   └── PLAN.md
│   │   ├── historical-intake-20261004/
│   │   │   ├── witness.can
│   │   │   └── witness.mjs
│   │   ├── language-proposals-20261007/
│   │   │   ├── README.md
│   │   │   ├── draft-intent-excerpts.md
│   │   │   ├── historical-draft-excerpts.md
│   │   │   ├── implementation-plan.md
│   │   │   ├── orchestration.md
│   │   │   ├── proposal-index.json
│   │   │   └── task-sequence.md
│   │   ├── muse-migration-20261004/
│   │   │   ├── dependency-design.md
│   │   │   ├── extraction-design.md
│   │   │   ├── feedback-design.md
│   │   │   ├── history-design.md
│   │   │   ├── inbox.md
│   │   │   ├── mail-recovery-design.md
│   │   │   ├── progress-design.md
│   │   │   └── review.md
│   │   ├── optional-dependency-closure-20261004/
│   │   │   ├── value-witness.can
│   │   │   ├── value-witness.mjs
│   │   │   ├── witness.can
│   │   │   └── witness.mjs
│   │   ├── proposals/
│   │   │   ├── build-generation/
│   │   │   │   ├── can.gen.example.toml
│   │   │   │   ├── choices.md
│   │   │   │   ├── implementation-contract.md
│   │   │   │   ├── implementation-plan.md
│   │   │   │   ├── persistence-redesign.md
│   │   │   │   └── proposal.json
│   │   │   ├── given-implicit/
│   │   │   │   ├── Todo.can
│   │   │   │   └── proposal.json
│   │   │   ├── given-rule-prompts/
│   │   │   │   └── proposal.json
│   │   │   ├── then-ai-style/
│   │   │   │   ├── Todo.can
│   │   │   │   └── proposal.json
│   │   │   └── then-css/
│   │   │       └── Todo.can
│   │   ├── rent-history-growth-20261004/
│   │   │   ├── negative-cases.json
│   │   │   ├── witness.can
│   │   │   └── witness.mjs
│   │   ├── AI-AND-SERVICE-DRAFTS.md
│   │   ├── COMPLEX-APPS.md
│   │   ├── UI-COMPONENTS.md
│   │   ├── can-dev-error-contract.md
│   │   ├── can-dev-first-slice.md
│   │   ├── can-dev-jev-ranking.md
│   │   ├── can-dev-server.md
│   │   ├── can-dev-session-control.md
│   │   ├── canonical-exposure-20261004.md
│   │   ├── company-policy-review-20261004.md
│   │   ├── cross-model-contained-loop.md
│   │   ├── delivery-association-20261004.md
│   │   ├── delivery-error-20261004.md
│   │   ├── delivery-leaf-grants-20261004.md
│   │   ├── delivery-recipe-overrides-20261004.md
│   │   ├── event-send-owner-row.md
│   │   ├── field-type-reuse-20261004.md
│   │   ├── historical-intake-20261004.md
│   │   ├── optional-dependency-closure-20261004.md
│   │   ├── owner-fanout-20261004.md
│   │   ├── person-selection-20261004.md
│   │   ├── propose-delivery-20261004.md
│   │   ├── rent-history-growth-20261004.md
│   │   ├── research-ai-capabilities-20261004.md
│   │   ├── research-demanding-apps-20261004.md
│   │   └── rule-search-owner-authority.md
│   ├── development/
│   │   ├── no-unit-tests.md
│   │   └── why-no-unit-tests.md
│   ├── ideal-filetree-plan/
│   │   ├── catalogue/
│   │   │   ├── draft-inputs.md
│   │   │   ├── evidence-consumers.md
│   │   │   └── inventory.md
│   │   ├── decomposition/
│   │   │   ├── index.md
│   │   │   └── size-flags.md
│   │   ├── finished-product/
│   │   │   ├── reviews/
│   │   │   │   ├── apps-delivery.md
│   │   │   │   ├── apps-language.md
│   │   │   │   ├── apps-work.md
│   │   │   │   ├── delivery.md
│   │   │   │   ├── language.md
│   │   │   │   ├── late-challenge-language.md
│   │   │   │   ├── late-dispatch.md
│   │   │   │   ├── late-work-tests.md
│   │   │   │   ├── product.md
│   │   │   │   └── work.md
│   │   │   ├── FP.IDENTITY-CONTRACT.contract.md
│   │   │   ├── apps.md
│   │   │   ├── findings.json
│   │   │   ├── findings.md
│   │   │   ├── late-source.md
│   │   │   ├── ownership.md
│   │   │   ├── target-tree.md
│   │   │   └── workflows.md
│   │   ├── reviews/
│   │   │   ├── artifact-emission.md
│   │   │   ├── authoring.md
│   │   │   ├── browser-presentation.md
│   │   │   ├── compiler.md
│   │   │   ├── delivery-upgrade.md
│   │   │   ├── identity-authority.md
│   │   │   ├── index.md
│   │   │   ├── language-checking.md
│   │   │   ├── language-current.md
│   │   │   ├── native-development.md
│   │   │   ├── platform-current.md
│   │   │   ├── platform.md
│   │   │   ├── providers-work-files.md
│   │   │   ├── repository-current.md
│   │   │   ├── repository.md
│   │   │   ├── runtime-current.md
│   │   │   ├── runtime-setup.md
│   │   │   ├── runtime.md
│   │   │   ├── saved-generation.md
│   │   │   ├── state-migration.md
│   │   │   └── values.md
│   │   ├── rust-package-audit/
│   │   │   ├── README.md
│   │   │   ├── adapters-ui.md
│   │   │   ├── cloudflare.md
│   │   │   ├── icu-shared-parser-plan.md
│   │   │   ├── state-work.md
│   │   │   └── values-interfaces.md
│   │   ├── slices/
│   │   │   └── index.md
│   │   ├── baseline.md
│   │   ├── decisions.md
│   │   ├── desired-tree.md
│   │   ├── findings.md
│   │   ├── implementation-lanes.md
│   │   ├── integration.md
│   │   ├── maintenance.md
│   │   ├── ownership.md
│   │   ├── package-ownership.md
│   │   ├── port-assessment.md
│   │   ├── proposed-tree.md
│   │   └── tasks.md
│   ├── implementation/
│   │   ├── can-dev-server/
│   │   │   ├── unfinished-cloud-handoff/
│   │   │   │   ├── dev-server-failures/
│   │   │   │   │   └── probe.mjs
│   │   │   │   ├── dev-server-lifecycle/
│   │   │   │   │   ├── compare-inputs.mjs
│   │   │   │   │   ├── crash-owner-a.mjs
│   │   │   │   │   ├── probe-auth.mjs
│   │   │   │   │   ├── probe-service.mjs
│   │   │   │   │   └── recover-owner-a.mjs
│   │   │   │   ├── generation-consumer/
│   │   │   │   │   ├── preview-mcp-create-fresh.mjs
│   │   │   │   │   └── preview-owner.mjs
│   │   │   │   ├── office-business/
│   │   │   │   │   └── probe.mjs
│   │   │   │   ├── office-browser.mjs
│   │   │   │   ├── stored-reference-hydration.unfinished.patch
│   │   │   │   └── t04-structural.patch
│   │   │   └── development-experience-research.html
│   │   ├── capability-roadmap-20261008/
│   │   │   ├── app-outcomes/
│   │   │   │   ├── README.md
│   │   │   │   ├── common-cases.json
│   │   │   │   ├── focused-cases.json
│   │   │   │   └── open-cases-and-uncertainty.json
│   │   │   ├── approval-compositions/
│   │   │   │   ├── CreativeRevisionReview.can
│   │   │   │   ├── ExpenseReview.can
│   │   │   │   └── README.md
│   │   │   ├── authenticated-actor-carrier-facts/
│   │   │   │   ├── README.md
│   │   │   │   └── control.mjs
│   │   │   ├── contract-inventory/
│   │   │   │   └── README.md
│   │   │   ├── dependent-input-comparison/
│   │   │   │   ├── approval/
│   │   │   │   │   └── proposed-binding-shell-full.can
│   │   │   │   ├── mutation-vectors/
│   │   │   │   │   └── M-09-missing-final-relation-full.can
│   │   │   │   ├── originals/
│   │   │   │   │   ├── shared/
│   │   │   │   │   │   ├── Employees.can
│   │   │   │   │   │   └── Locations.can
│   │   │   │   │   ├── CanApprove.can
│   │   │   │   │   ├── CanApprove.md
│   │   │   │   │   ├── CanRent.can
│   │   │   │   │   └── CanRent.md
│   │   │   │   ├── supplementary/
│   │   │   │   │   ├── CountryRegion-current-nested-full.can
│   │   │   │   │   ├── CountryRegion-custom-composition-shell-full.can
│   │   │   │   │   ├── CountryRegion-intent.md
│   │   │   │   │   └── CountryRegion-proposed-binding-shell-full.can
│   │   │   │   ├── README.md
│   │   │   │   ├── expected-vectors.json
│   │   │   │   └── lifecycle-requirements.json
│   │   │   ├── enum-comparison/
│   │   │   │   ├── additional-contract-vectors/
│   │   │   │   │   ├── README.md
│   │   │   │   │   ├── expected-outcomes.json
│   │   │   │   │   ├── same-spelling-different-owner.can
│   │   │   │   │   ├── same-spelling-owner-control.can
│   │   │   │   │   ├── unsupported-destructuring.can
│   │   │   │   │   ├── unsupported-guarded-arm.can
│   │   │   │   │   ├── unsupported-or-case.can
│   │   │   │   │   └── unsupported-tagged-union.can
│   │   │   │   ├── approval/
│   │   │   │   │   ├── current-if-add-case-full.can
│   │   │   │   │   ├── current-if-full.can
│   │   │   │   │   ├── current-if-handler.can
│   │   │   │   │   ├── current-if-omit-case-full.can
│   │   │   │   │   ├── current-if-remove-owner-case-full.can
│   │   │   │   │   ├── domain.json
│   │   │   │   │   ├── improved-if-analysis-add-case-full.can
│   │   │   │   │   ├── improved-if-analysis-full.can
│   │   │   │   │   ├── improved-if-analysis-handler.can
│   │   │   │   │   ├── improved-if-analysis-omit-case-full.can
│   │   │   │   │   ├── improved-if-analysis-remove-owner-case-full.can
│   │   │   │   │   ├── proposed-match-add-case-full.can
│   │   │   │   │   ├── proposed-match-full.can
│   │   │   │   │   ├── proposed-match-handler.can
│   │   │   │   │   ├── proposed-match-omit-case-full.can
│   │   │   │   │   └── proposed-match-remove-owner-case-full.can
│   │   │   │   ├── contract-advice/
│   │   │   │   │   └── README.md
│   │   │   │   ├── generation/
│   │   │   │   │   ├── current-if-add-case-full.can
│   │   │   │   │   ├── current-if-full.can
│   │   │   │   │   ├── current-if-handler.can
│   │   │   │   │   ├── current-if-omit-case-full.can
│   │   │   │   │   ├── current-if-remove-owner-case-full.can
│   │   │   │   │   ├── domain.json
│   │   │   │   │   ├── improved-if-analysis-add-case-full.can
│   │   │   │   │   ├── improved-if-analysis-full.can
│   │   │   │   │   ├── improved-if-analysis-handler.can
│   │   │   │   │   ├── improved-if-analysis-omit-case-full.can
│   │   │   │   │   ├── improved-if-analysis-remove-owner-case-full.can
│   │   │   │   │   ├── proposed-match-add-case-full.can
│   │   │   │   │   ├── proposed-match-full.can
│   │   │   │   │   ├── proposed-match-handler.can
│   │   │   │   │   ├── proposed-match-omit-case-full.can
│   │   │   │   │   └── proposed-match-remove-owner-case-full.can
│   │   │   │   ├── generation-effects/
│   │   │   │   │   ├── catalog-add-case-input.json
│   │   │   │   │   ├── current-if-full.can
│   │   │   │   │   ├── current-if-handler.can
│   │   │   │   │   ├── improved-if-analysis-full.can
│   │   │   │   │   ├── improved-if-analysis-handler.can
│   │   │   │   │   ├── proposed-match-full.can
│   │   │   │   │   └── proposed-match-handler.can
│   │   │   │   ├── ordinary/
│   │   │   │   │   ├── current-if-add-case-full.can
│   │   │   │   │   ├── current-if-full.can
│   │   │   │   │   ├── current-if-handler.can
│   │   │   │   │   ├── current-if-omit-case-full.can
│   │   │   │   │   ├── current-if-remove-owner-case-full.can
│   │   │   │   │   ├── domain.json
│   │   │   │   │   ├── improved-if-analysis-add-case-full.can
│   │   │   │   │   ├── improved-if-analysis-full.can
│   │   │   │   │   ├── improved-if-analysis-handler.can
│   │   │   │   │   ├── improved-if-analysis-omit-case-full.can
│   │   │   │   │   ├── improved-if-analysis-remove-owner-case-full.can
│   │   │   │   │   ├── proposed-match-add-case-full.can
│   │   │   │   │   ├── proposed-match-full.can
│   │   │   │   │   ├── proposed-match-handler.can
│   │   │   │   │   ├── proposed-match-omit-case-full.can
│   │   │   │   │   └── proposed-match-remove-owner-case-full.can
│   │   │   │   ├── originals/
│   │   │   │   │   ├── CanApprove.can
│   │   │   │   │   ├── CanCreative.can
│   │   │   │   │   ├── CanHire.can
│   │   │   │   │   ├── Generation.can
│   │   │   │   │   └── TeamTasks.can
│   │   │   │   ├── proposed-contract-inputs/
│   │   │   │   │   ├── branch-scope.can
│   │   │   │   │   ├── duplicate-case.can
│   │   │   │   │   ├── foreign-case.can
│   │   │   │   │   ├── lexical-collision.can
│   │   │   │   │   ├── nullable-guarded.can
│   │   │   │   │   ├── nullable-subject.can
│   │   │   │   │   ├── unsupported-wildcard.can
│   │   │   │   │   └── wrong-return-type.can
│   │   │   │   ├── README.md
│   │   │   │   └── expected-cases.json
│   │   │   ├── f1-invocation/
│   │   │   │   ├── ManagedBypassRejected.can
│   │   │   │   ├── MemberControl.can
│   │   │   │   ├── NumericControl.can
│   │   │   │   ├── REPORT.md
│   │   │   │   ├── early-dependent-vector-fatal-preserved.json
│   │   │   │   ├── numeric-control.mjs
│   │   │   │   ├── read-control.mjs
│   │   │   │   └── run.mjs
│   │   │   ├── f1-metadata/
│   │   │   │   ├── Bounded.can
│   │   │   │   ├── REPORT.md
│   │   │   │   ├── Unsupported.can
│   │   │   │   ├── consume.mjs
│   │   │   │   ├── duration-members.can
│   │   │   │   ├── int-control.can
│   │   │   │   ├── int-members.can
│   │   │   │   ├── run-compiler.py
│   │   │   │   └── unsupported-consume.mjs
│   │   │   ├── nullable-ref-repair/
│   │   │   │   ├── REPORT.md
│   │   │   │   └── run.mjs
│   │   │   ├── rules-machine/
│   │   │   │   ├── RuleMachine.can
│   │   │   │   └── RuleMachineCore.can
│   │   │   ├── runtime-pure-helpers/
│   │   │   │   ├── DatetimeControl.can
│   │   │   │   └── REPORT.md
│   │   │   ├── selected-page-refresh/
│   │   │   │   ├── Images.can
│   │   │   │   ├── emitted-module.mjs
│   │   │   │   ├── generating.html
│   │   │   │   ├── ready.html
│   │   │   │   ├── report.md
│   │   │   │   └── state-machine-consumer.mjs
│   │   │   ├── verified-context-execution-before/
│   │   │   │   ├── REPORT.md
│   │   │   │   └── VerifiedContext.can
│   │   │   ├── verified-context-inventory/
│   │   │   │   └── README.md
│   │   │   ├── verified-context-repair/
│   │   │   │   ├── REPORT.md
│   │   │   │   ├── VerifiedContext.can
│   │   │   │   └── run-after.mjs
│   │   │   ├── README.md
│   │   │   ├── model-rule-contract.md
│   │   │   ├── nullable-ref-decision-note.md
│   │   │   ├── proposal-status.json
│   │   │   └── witness-registration.md
│   │   ├── challenge-audit-run/
│   │   │   ├── evidence/
│   │   │   │   ├── app-intent.md
│   │   │   │   ├── census-20261013.md
│   │   │   │   ├── containment-decision.md
│   │   │   │   ├── continuation-contract.md
│   │   │   │   ├── execution-contract.md
│   │   │   │   ├── fanout-decision.md
│   │   │   │   ├── fanout-proof.md
│   │   │   │   ├── hook-decision.md
│   │   │   │   ├── interface-inventory.md
│   │   │   │   ├── read-decision.md
│   │   │   │   ├── root-causes.md
│   │   │   │   └── t34-plan.md
│   │   │   └── t33-resolution.md
│   │   ├── compiler-completion/
│   │   │   ├── action-operation-targets/
│   │   │   │   ├── independent-review/
│   │   │   │   │   ├── corrected/
│   │   │   │   │   │   ├── generated/
│   │   │   │   │   │   │   └── $can$m$54617267657473.mjs
│   │   │   │   │   │   └── execute.mjs
│   │   │   │   │   ├── generated/
│   │   │   │   │   │   ├── $can$m$54.mjs
│   │   │   │   │   │   └── $can$m$54617267657473.mjs
│   │   │   │   │   ├── choose-throw-execute.mjs
│   │   │   │   │   ├── choose-throw.can
│   │   │   │   │   ├── choose.can
│   │   │   │   │   ├── execute.mjs
│   │   │   │   │   ├── format-only.diff
│   │   │   │   │   ├── formatted-reviewed-ir.rs
│   │   │   │   │   ├── group.can
│   │   │   │   │   ├── initial-reject.md
│   │   │   │   │   ├── invocation-choose-valid.can
│   │   │   │   │   ├── invocation-choose.can
│   │   │   │   │   ├── member-object-valid.can
│   │   │   │   │   ├── member-object.can
│   │   │   │   │   ├── raw-choose-binding-valid.can
│   │   │   │   │   ├── raw-choose-binding.can
│   │   │   │   │   ├── raw_choose.can
│   │   │   │   │   ├── review.md
│   │   │   │   │   └── reviewed-correction-ir.rs
│   │   │   │   ├── aliased-crud.can
│   │   │   │   ├── before.can
│   │   │   │   ├── correction-action-choose.can
│   │   │   │   ├── correction-invocation-choose.can
│   │   │   │   ├── correction-object-member.can
│   │   │   │   └── evidence.md
│   │   │   ├── bdd-facts/
│   │   │   │   ├── consumer-policy/
│   │   │   │   │   ├── producer-inventory.md
│   │   │   │   │   └── proposal.md
│   │   │   │   ├── implementation/
│   │   │   │   │   ├── bdd_checked_facts.rs
│   │   │   │   │   ├── codegen-restoration-proposal.patch
│   │   │   │   │   ├── report.md
│   │   │   │   │   └── source.patch
│   │   │   │   └── independent-review/
│   │   │   │       ├── assessment.md
│   │   │   │       ├── expected-enum.can
│   │   │   │       ├── failed-result.can
│   │   │   │       ├── forward-let.can
│   │   │   │       ├── known-wrong-type.can
│   │   │   │       ├── known.can
│   │   │   │       ├── known.test-0.mjs
│   │   │   │       ├── ordered-alias.can
│   │   │   │       ├── ordered-alias.test-0.mjs
│   │   │   │       ├── ownership.can
│   │   │   │       ├── privacy-import.can
│   │   │   │       ├── privacy-qualified.can
│   │   │   │       ├── privacy.can
│   │   │   │       ├── result-only.can
│   │   │   │       ├── result-only.test-0.mjs
│   │   │   │       ├── runtime-controls.mjs
│   │   │   │       ├── sequence-alias.can
│   │   │   │       ├── sequence-alias.test-0.mjs
│   │   │   │       ├── sequence-order.can
│   │   │   │       ├── sequence-order.test-0.mjs
│   │   │   │       ├── unknown-callee.can
│   │   │   │       └── unknown-cell.can
│   │   │   ├── build-metadata/
│   │   │   │   └── README.md
│   │   │   ├── checked-cohort/
│   │   │   │   ├── independent-review/
│   │   │   │   │   ├── cli-fixtures/
│   │   │   │   │   │   ├── a.can
│   │   │   │   │   │   ├── b.can
│   │   │   │   │   │   └── broken.can
│   │   │   │   │   ├── compile-fail/
│   │   │   │   │   │   ├── catalog_identity_access.rs
│   │   │   │   │   │   ├── catalog_mutation.rs
│   │   │   │   │   │   ├── checked_program_literal.rs
│   │   │   │   │   │   ├── cohort_field_access.rs
│   │   │   │   │   │   ├── cohort_module_access.rs
│   │   │   │   │   │   ├── db_identity_access.rs
│   │   │   │   │   │   ├── selection_mutation.rs
│   │   │   │   │   │   └── source_mutation.rs
│   │   │   │   │   ├── external-caller/
│   │   │   │   │   │   ├── src/
│   │   │   │   │   │   │   └── lib.rs
│   │   │   │   │   │   ├── tests/
│   │   │   │   │   │   │   ├── caller_cli.rs
│   │   │   │   │   │   │   └── public_controls.rs
│   │   │   │   │   │   ├── Cargo.lock
│   │   │   │   │   │   └── Cargo.toml
│   │   │   │   │   ├── b4-examples-caller-migration.diff
│   │   │   │   │   └── review.md
│   │   │   │   ├── cli-control.can
│   │   │   │   ├── probe.rs
│   │   │   │   └── selected-contract.md
│   │   │   ├── collection-calls/
│   │   │   │   └── facts.md
│   │   │   ├── comment-preservation/
│   │   │   │   ├── independent-probes.rs
│   │   │   │   └── independent-review.md
│   │   │   ├── corpus-admission/
│   │   │   │   ├── before/
│   │   │   │   │   └── ir.rs
│   │   │   │   ├── independent-review/
│   │   │   │   │   ├── REVIEW.md
│   │   │   │   │   ├── duplicate.can
│   │   │   │   │   ├── lookalikes.can
│   │   │   │   │   ├── no-body.can
│   │   │   │   │   ├── probe.rs
│   │   │   │   │   └── recovery.can
│   │   │   │   ├── REPORT.md
│   │   │   │   ├── replay.py
│   │   │   │   └── source.patch
│   │   │   ├── cycle-witness/
│   │   │   │   ├── independent-review/
│   │   │   │   │   ├── ASSESSMENT.md
│   │   │   │   │   └── probe.rs
│   │   │   │   ├── compiler_probe.rs
│   │   │   │   ├── replay_observer.py
│   │   │   │   └── types.patch
│   │   │   ├── default-read-dependency/
│   │   │   │   └── outcome.md
│   │   │   ├── default-representation/
│   │   │   │   ├── independent-review/
│   │   │   │   │   └── review.md
│   │   │   │   └── disposition.md
│   │   │   ├── delimiter-recovery/
│   │   │   │   ├── independent-review/
│   │   │   │   │   ├── controls.rs
│   │   │   │   │   └── report.md
│   │   │   │   ├── balanced-description-schema.can
│   │   │   │   ├── balanced-list-call.can
│   │   │   │   ├── balanced-nested-statements.can
│   │   │   │   ├── balanced-same-dedent-schema.can
│   │   │   │   ├── balanced-string-punctuation.can
│   │   │   │   ├── cases.json
│   │   │   │   ├── independent-module-after-open-schema.can
│   │   │   │   ├── probe.rs
│   │   │   │   ├── report.md
│   │   │   │   ├── sibling-open-call.can
│   │   │   │   ├── sibling-open-list.can
│   │   │   │   ├── sibling-open-schema.can
│   │   │   │   ├── sibling-unterminated-string.can
│   │   │   │   └── unfinished-more-indented.can
│   │   │   ├── docs-support/
│   │   │   │   └── README.md
│   │   │   ├── editor-lifecycle/
│   │   │   │   ├── independent-corrected-out/
│   │   │   │   │   ├── client.js
│   │   │   │   │   └── extension.js
│   │   │   │   ├── independent-out/
│   │   │   │   │   ├── client.js
│   │   │   │   │   └── extension.js
│   │   │   │   ├── README.md
│   │   │   │   ├── before-observe.cjs
│   │   │   │   ├── independent-corrections.cjs
│   │   │   │   └── independent-gaps.cjs
│   │   │   ├── editor-project-scope/
│   │   │   │   ├── catalog-client.cjs
│   │   │   │   └── outcome.md
│   │   │   ├── email-admission/
│   │   │   │   ├── implementation/
│   │   │   │   │   └── probe.mjs
│   │   │   │   ├── independent-review/
│   │   │   │   │   ├── fixtures/
│   │   │   │   │   │   ├── 0/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 1/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 10/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 100/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 101/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 102/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 103/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 104/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 105/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 106/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 107/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 108/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 109/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 11/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 110/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 111/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 112/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 113/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 114/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 115/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 116/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 117/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 118/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 119/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 12/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 120/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 121/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 122/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 123/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 124/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 125/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 126/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 127/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 128/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 129/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 13/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 130/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 131/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 132/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 133/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 134/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 135/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 136/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 137/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 138/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 139/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 14/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 140/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 141/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 142/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 143/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 144/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 15/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 16/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 17/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 18/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 19/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 2/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 20/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 21/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 22/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 23/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 24/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 25/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 26/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 27/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 28/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 29/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 3/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 30/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 31/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 32/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 33/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 34/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 35/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 36/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 37/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 38/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 39/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 4/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 40/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 41/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 42/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 43/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 44/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 45/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 46/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 47/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 48/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 49/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 5/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 50/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 51/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 52/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 53/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 54/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 55/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 56/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 57/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 58/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 59/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 6/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 60/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 61/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 62/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 63/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 64/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 65/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 66/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 67/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 68/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 69/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 7/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 70/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 71/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 72/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 73/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 74/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 75/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 76/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 77/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 78/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 79/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 8/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 80/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 81/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 82/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 83/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 84/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 85/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 86/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 87/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 88/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 89/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 9/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 90/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 91/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 92/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 93/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 94/
│   │   │   │   │   │   │   ├── $can$m$52.mjs
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 95/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 96/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 97/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   ├── 98/
│   │   │   │   │   │   │   └── value.can
│   │   │   │   │   │   └── 99/
│   │   │   │   │   │       ├── $can$m$52.mjs
│   │   │   │   │   │       └── value.can
│   │   │   │   │   └── check.mjs
│   │   │   │   ├── probe.mjs
│   │   │   │   ├── selected-contract-proposal.md
│   │   │   │   └── vectors.json
│   │   │   ├── enum-membership/
│   │   │   │   ├── local-shadow.can
│   │   │   │   ├── report.md
│   │   │   │   ├── review-probes.py
│   │   │   │   ├── review-runner.mjs
│   │   │   │   ├── review-source.can
│   │   │   │   └── review.md
│   │   │   ├── flat-stack/
│   │   │   │   ├── README.md
│   │   │   │   ├── review-probes.py
│   │   │   │   ├── review-runner.mjs
│   │   │   │   ├── review-short-runner.mjs
│   │   │   │   ├── review-short.can
│   │   │   │   ├── review-source-attempt1.can
│   │   │   │   ├── review-source.can
│   │   │   │   ├── review.md
│   │   │   │   └── stages.rs
│   │   │   ├── frame-admission/
│   │   │   │   ├── independent-review/
│   │   │   │   │   ├── process-controls.py
│   │   │   │   │   ├── reader-controls.rs
│   │   │   │   │   ├── report.md
│   │   │   │   │   ├── transport-fragment-original.rs
│   │   │   │   │   └── transport-fragment.rs
│   │   │   │   └── decision.md
│   │   │   ├── integration-after-bindings/
│   │   │   │   ├── after-bdd-ui/
│   │   │   │   │   └── flat-runtime-triage/
│   │   │   │   │       ├── independent-review/
│   │   │   │   │       │   ├── qualification.md
│   │   │   │   │       │   └── reproduce.py
│   │   │   │   │       ├── clock-probe.rs
│   │   │   │   │       ├── diagnosis.md
│   │   │   │   │       ├── source-after.rs
│   │   │   │   │       ├── source-before.rs
│   │   │   │   │       └── source.diff
│   │   │   │   └── queue-oracle-independent-review/
│   │   │   │       ├── ide-followup/
│   │   │   │       │   └── assessment.md
│   │   │   │       └── assessment.md
│   │   │   ├── invocation-join/
│   │   │   │   ├── independent-review/
│   │   │   │   │   ├── generated/
│   │   │   │   │   │   └── $can$m$496e766f636174696f6e73.mjs
│   │   │   │   │   ├── bare.can
│   │   │   │   │   ├── empty.can
│   │   │   │   │   ├── execute.mjs
│   │   │   │   │   ├── nullable_required.can
│   │   │   │   │   ├── owner-controls.mjs
│   │   │   │   │   └── review.md
│   │   │   │   ├── evidence.md
│   │   │   │   └── source.diff
│   │   │   ├── json-frame-oracles/
│   │   │   │   └── README.md
│   │   │   ├── json-reader/
│   │   │   │   ├── independent-review/
│   │   │   │   │   ├── README.md
│   │   │   │   │   ├── control.rs
│   │   │   │   │   └── run.py
│   │   │   │   ├── README.md
│   │   │   │   ├── feature-control.rs
│   │   │   │   ├── finite.rs
│   │   │   │   └── run.py
│   │   │   ├── list-empty-producer/
│   │   │   │   └── outcome.md
│   │   │   ├── localized-format/
│   │   │   │   └── outcome.md
│   │   │   ├── lsp-support/
│   │   │   │   ├── direct-controls.rs
│   │   │   │   └── disposition.md
│   │   │   ├── map-attribution/
│   │   │   │   ├── consumer.mjs
│   │   │   │   ├── failure.can
│   │   │   │   └── outcome.md
│   │   │   ├── map-support/
│   │   │   │   ├── controls.rs
│   │   │   │   ├── decision.md
│   │   │   │   ├── get_mappings.rs
│   │   │   │   ├── private_encoder.rs
│   │   │   │   ├── replay.py
│   │   │   │   └── serialize_trait.rs
│   │   │   ├── markdown-owner/
│   │   │   │   ├── implementation/
│   │   │   │   │   ├── exact.diff
│   │   │   │   │   ├── replay.mjs
│   │   │   │   │   └── report.md
│   │   │   │   ├── independent-review/
│   │   │   │   │   ├── cli-followup/
│   │   │   │   │   │   ├── qualification.md
│   │   │   │   │   │   └── reproduce.mjs
│   │   │   │   │   ├── reproduce.mjs
│   │   │   │   │   └── review.md
│   │   │   │   └── research/
│   │   │   │       ├── owner-contract.md
│   │   │   │       └── reproduce.mjs
│   │   │   ├── message-slot-coverage/
│   │   │   │   ├── independent-review/
│   │   │   │   │   └── qualification.md
│   │   │   │   ├── source/
│   │   │   │   │   └── compiler/
│   │   │   │   │       ├── src/
│   │   │   │   │       │   └── analysis/
│   │   │   │   │       │       └── types.rs
│   │   │   │   │       ├── tests/
│   │   │   │   │       │   ├── analysis.rs
│   │   │   │   │       │   ├── b4_check.rs
│   │   │   │   │       │   ├── check.rs
│   │   │   │   │       │   ├── message_slot_coverage.rs
│   │   │   │   │       │   └── temporal_message_types.rs
│   │   │   │   │       └── Cargo.lock
│   │   │   │   ├── README.md
│   │   │   │   ├── analysis-fixture.patch
│   │   │   │   ├── anonymous-binding-expected-gap.json
│   │   │   │   ├── anonymous-binding-probe.can
│   │   │   │   └── types-coverage.patch
│   │   │   ├── money-defaults/
│   │   │   │   └── README.md
│   │   │   ├── native-scalar-presentation/
│   │   │   │   ├── $can$m$54656d706f72616c50726573656e746174696f6e.mjs
│   │   │   │   ├── README.md
│   │   │   │   ├── model-wire.mjs
│   │   │   │   └── run.mjs
│   │   │   ├── numeric-control-producer/
│   │   │   │   ├── app-definition-declaration.mjs
│   │   │   │   ├── module-0.mjs
│   │   │   │   └── source.can
│   │   │   ├── operation-result-producer/
│   │   │   │   └── facts.md
│   │   │   ├── optional-body-accounting/
│   │   │   │   └── README.md
│   │   │   ├── overload-owner-seam/
│   │   │   │   └── README.md
│   │   │   ├── overload-trials/
│   │   │   │   ├── harness/
│   │   │   │   │   ├── src/
│   │   │   │   │   │   └── main.rs
│   │   │   │   │   ├── Cargo.lock
│   │   │   │   │   └── Cargo.toml
│   │   │   │   ├── declaration_defaults.can
│   │   │   │   ├── format_locale.can
│   │   │   │   ├── format_null.can
│   │   │   │   ├── format_plain.can
│   │   │   │   ├── local_bad_fold.can
│   │   │   │   ├── local_bad_fold_named.can
│   │   │   │   ├── local_bad_zone.can
│   │   │   │   ├── local_good.can
│   │   │   │   ├── min_nonempty.can
│   │   │   │   ├── money_decimal.can
│   │   │   │   ├── money_int.can
│   │   │   │   ├── money_named.can
│   │   │   │   ├── report.md
│   │   │   │   └── sum_money.can
│   │   │   ├── policy-layout-support/
│   │   │   │   └── disposition.md
│   │   │   ├── process-boundaries/
│   │   │   │   ├── independent-review/
│   │   │   │   │   ├── probe.py
│   │   │   │   │   └── review.md
│   │   │   │   └── README.md
│   │   │   ├── public-fragment-support/
│   │   │   │   ├── independent-review/
│   │   │   │   │   └── qualification.md
│   │   │   │   └── disposition.md
│   │   │   ├── query-order/
│   │   │   │   └── outcome.md
│   │   │   ├── release-inventory/
│   │   │   │   ├── attempt1/
│   │   │   │   │   └── README.md
│   │   │   │   ├── independent-review/
│   │   │   │   │   ├── corrected-report.md
│   │   │   │   │   └── report.md
│   │   │   │   └── README.md
│   │   │   ├── release-prerequisites/
│   │   │   │   ├── notices/
│   │   │   │   │   ├── bitflags-1.3.2/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── bitflags-2.13.2/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── bitvec-1.1.1/
│   │   │   │   │   │   └── LICENSE.txt
│   │   │   │   │   ├── block-buffer-0.10.4/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── bumpalo-3.20.3/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── cfg-if-1.0.5/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── cpufeatures-0.2.17/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── crypto-common-0.1.7/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── data-encoding-2.11.1/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── debugid-0.8.0/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── digest-0.10.7/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── displaydoc-0.2.7/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── errno-0.3.14/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── fastrand-2.5.0/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── fluent-uri-0.1.4/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── form_urlencoded-1.2.2/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── funty-2.0.0/
│   │   │   │   │   │   └── LICENSE.txt
│   │   │   │   │   ├── futures-core-0.3.34/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── futures-task-0.3.34/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── futures-util-0.3.34/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── generic-array-0.14.7/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── getrandom-0.4.3/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── icu_collections-2.3.0/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── icu_locale_core-2.3.0/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── icu_normalizer-2.3.0/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── icu_normalizer_data-2.3.0/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── icu_properties-2.3.0/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── icu_properties_data-2.3.0/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── icu_provider-2.3.1/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── idna-1.1.0/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── idna_adapter-1.2.2/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── if_chain-1.0.3/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── itoa-1.0.18/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── js-sys-0.3.106/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── libc-0.2.190/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── linux-raw-sys-0.12.1/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   ├── LICENSE-Apache-2.0_WITH_LLVM-exception
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── litemap-0.8.3/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── lsp-types-0.97.0/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── memchr-2.8.3/
│   │   │   │   │   │   ├── COPYING
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── once_cell-1.21.4/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── outref-0.5.2/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── percent-encoding-2.3.2/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── pin-project-lite-0.2.17/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── potential_utf-0.1.6/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── proc-macro2-1.0.107/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── quote-1.0.47/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── r-efi-6.0.0/
│   │   │   │   │   │   └── AUTHORS
│   │   │   │   │   ├── radium-0.7.0/
│   │   │   │   │   │   └── LICENSE.txt
│   │   │   │   │   ├── rustc-hash-2.1.3/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── rustix-1.1.5/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   ├── LICENSE-Apache-2.0_WITH_LLVM-exception
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── rustversion-1.0.23/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── serde-1.0.229/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── serde_core-1.0.229/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── serde_derive-1.0.229/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── serde_json-1.0.151/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── serde_repr-0.1.21/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── sha2-0.10.9/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── slab-0.4.12/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── smallvec-1.16.2/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── sourcemap-9.3.2/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── stable_deref_trait-1.2.1/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── syn-2.0.119/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── syn-3.0.6/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── synstructure-0.13.2/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── synstructure-0.14.0/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── tap-1.0.1/
│   │   │   │   │   │   └── LICENSE.txt
│   │   │   │   │   ├── tempfile-3.27.0/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── tinystr-0.8.4/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── typenum-1.20.1/
│   │   │   │   │   │   ├── LICENSE
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── unicode-id-start-1.5.0/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   ├── LICENSE-MIT
│   │   │   │   │   │   └── LICENSE-UNICODE
│   │   │   │   │   ├── unicode-ident-1.0.26/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   ├── LICENSE-MIT
│   │   │   │   │   │   └── LICENSE-UNICODE
│   │   │   │   │   ├── url-2.5.8/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── utf8_iter-1.0.4/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── uuid-1.27.0/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── version_check-0.9.5/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── wasm-bindgen-0.2.129/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── wasm-bindgen-macro-0.2.129/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── wasm-bindgen-macro-support-0.2.129/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── wasm-bindgen-shared-0.2.129/
│   │   │   │   │   │   ├── LICENSE-APACHE
│   │   │   │   │   │   └── LICENSE-MIT
│   │   │   │   │   ├── windows-link-0.2.1/
│   │   │   │   │   │   ├── license-apache-2.0
│   │   │   │   │   │   └── license-mit
│   │   │   │   │   ├── windows-sys-0.61.2/
│   │   │   │   │   │   ├── license-apache-2.0
│   │   │   │   │   │   └── license-mit
│   │   │   │   │   ├── writeable-0.6.4/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── wyz-0.5.1/
│   │   │   │   │   │   └── LICENSE.txt
│   │   │   │   │   ├── yoke-0.8.3/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── yoke-derive-0.8.2/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── zerofrom-0.1.8/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── zerofrom-derive-0.1.8/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── zerotrie-0.2.5/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── zerovec-0.11.8/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   ├── zerovec-derive-0.11.6/
│   │   │   │   │   │   └── LICENSE
│   │   │   │   │   └── zmij-1.0.23/
│   │   │   │   │       └── LICENSE-MIT
│   │   │   │   ├── supplemental-notices/
│   │   │   │   │   └── simd-LICENSE
│   │   │   │   ├── README.md
│   │   │   │   ├── THIRD-PARTY-NOTICES-aarch64-apple-darwin.txt
│   │   │   │   ├── THIRD-PARTY-NOTICES-x86_64-unknown-linux-gnu.txt
│   │   │   │   ├── archives.json
│   │   │   │   ├── supplemental-notices.json
│   │   │   │   └── target-closures.json
│   │   │   ├── renderer-failure-qualification/
│   │   │   │   ├── README.md
│   │   │   │   ├── input.can
│   │   │   │   ├── invalid.can
│   │   │   │   ├── must-not-run.py
│   │   │   │   ├── renderer-closed-input-after-duplex.py
│   │   │   │   ├── renderer-closed-input.py
│   │   │   │   ├── renderer-duplex.py
│   │   │   │   ├── renderer-empty.py
│   │   │   │   ├── renderer-invalid-utf8.py
│   │   │   │   ├── renderer-nonzero-after-duplex.py
│   │   │   │   ├── renderer-nonzero.py
│   │   │   │   ├── renderer-signal.py
│   │   │   │   └── renderer-success.py
│   │   │   ├── renderer-lifecycle/
│   │   │   │   ├── README.md
│   │   │   │   └── independent-duplex.py
│   │   │   ├── representability/
│   │   │   │   ├── implementation/
│   │   │   │   │   └── source.diff
│   │   │   │   ├── independent-review/
│   │   │   │   │   ├── probe.rs
│   │   │   │   │   ├── review.md
│   │   │   │   │   ├── reviewed-source.diff
│   │   │   │   │   └── run.py
│   │   │   │   └── research/
│   │   │   │       ├── public-fragment-baseline/
│   │   │   │       │   ├── probe.rs
│   │   │   │       │   └── run.py
│   │   │   │       └── owner-contract-candidates.md
│   │   │   ├── retained-support-review/
│   │   │   │   └── report.md
│   │   │   ├── runtime-export-join/
│   │   │   │   └── implementation/
│   │   │   │       └── report.md
│   │   │   ├── selected-app-locale/
│   │   │   │   └── README.md
│   │   │   ├── selected-calls/
│   │   │   │   ├── format-context-policy/
│   │   │   │   │   └── decision.md
│   │   │   │   ├── implementation/
│   │   │   │   │   ├── runtime/
│   │   │   │   │   │   ├── alias/
│   │   │   │   │   │   │   ├── $can$m$436f6e73756d6572.mjs
│   │   │   │   │   │   │   └── $can$m$50726f7669646572.mjs
│   │   │   │   │   │   ├── await-scenario/
│   │   │   │   │   │   │   └── $can$m$54.mjs
│   │   │   │   │   │   ├── localized/
│   │   │   │   │   │   │   └── $can$m$54.mjs
│   │   │   │   │   │   ├── same-arity/
│   │   │   │   │   │   │   └── $can$m$54.mjs
│   │   │   │   │   │   ├── selected/
│   │   │   │   │   │   │   └── $can$m$54.mjs
│   │   │   │   │   │   ├── alias.can
│   │   │   │   │   │   ├── await-purity.can
│   │   │   │   │   │   ├── await-scenario.can
│   │   │   │   │   │   ├── builtin-exact-arity.can
│   │   │   │   │   │   ├── localized-named.can
│   │   │   │   │   │   ├── localized.can
│   │   │   │   │   │   ├── malformed.can
│   │   │   │   │   │   ├── missing-named.can
│   │   │   │   │   │   ├── missing-reversed.can
│   │   │   │   │   │   ├── same-arity.can
│   │   │   │   │   │   ├── selected.can
│   │   │   │   │   │   ├── unbound-source.can
│   │   │   │   │   │   ├── user-required-slot.can
│   │   │   │   │   │   └── user-unknown-slot.can
│   │   │   │   │   ├── probe.mjs
│   │   │   │   │   ├── report.md
│   │   │   │   │   └── selected-binding.patch
│   │   │   │   ├── independent-review/
│   │   │   │   │   ├── aliases/
│   │   │   │   │   │   ├── $can$m$416c6961734175646974.mjs
│   │   │   │   │   │   └── $can$m$4f776e6572.mjs
│   │   │   │   │   ├── awaits/
│   │   │   │   │   │   └── $can$m$41776169744175646974.mjs
│   │   │   │   │   ├── controls/
│   │   │   │   │   │   └── $can$m$4175646974.mjs
│   │   │   │   │   ├── winning/
│   │   │   │   │   │   └── $can$m$57696e.mjs
│   │   │   │   │   ├── winning-names/
│   │   │   │   │   │   └── $can$m$57696e.mjs
│   │   │   │   │   ├── aliases.can
│   │   │   │   │   ├── awaits.can
│   │   │   │   │   ├── controls.can
│   │   │   │   │   ├── controls.mjs
│   │   │   │   │   ├── escaped-missing.can
│   │   │   │   │   ├── exact-arity.can
│   │   │   │   │   ├── malformed-reversed.can
│   │   │   │   │   ├── missing-sorted.can
│   │   │   │   │   ├── report.md
│   │   │   │   │   ├── reviewed-production.patch
│   │   │   │   │   ├── winning-names.can
│   │   │   │   │   └── winning.can
│   │   │   │   └── research/
│   │   │   │       ├── locale-owner/
│   │   │   │       │   ├── locale-conflicting-composition-0.mjs
│   │   │   │       │   ├── locale-conflicting-composition-1.mjs
│   │   │   │       │   ├── locale-conflicting-composition-2.mjs
│   │   │   │       │   ├── locale-conflicting-composition-3.mjs
│   │   │   │       │   ├── locale-conflicting-composition.can
│   │   │   │       │   ├── locale-identical-composition-0.mjs
│   │   │   │       │   ├── locale-identical-composition-1.mjs
│   │   │   │       │   ├── locale-identical-composition-2.mjs
│   │   │   │       │   ├── locale-identical-composition-3.mjs
│   │   │   │       │   ├── locale-identical-composition.can
│   │   │   │       │   ├── locale-shared-0.mjs
│   │   │   │       │   ├── locale-shared-1.mjs
│   │   │   │       │   ├── locale-shared-2.mjs
│   │   │   │       │   ├── locale-shared.can
│   │   │   │       │   ├── locale-simple-0.mjs
│   │   │   │       │   ├── locale-simple.can
│   │   │   │       │   ├── probe.mjs
│   │   │   │       │   ├── probe.py
│   │   │   │       │   └── report.md
│   │   │   │       ├── alias-call.can
│   │   │   │       ├── contract.md
│   │   │   │       ├── custom-probe.mjs
│   │   │   │       ├── custom-probe.py
│   │   │   │       ├── derive-default.can
│   │   │   │       ├── derive-default.mjs
│   │   │   │       ├── derive-named.can
│   │   │   │       ├── duplicate-name.can
│   │   │   │       ├── message-dynamic.can
│   │   │   │       ├── message-dynamic.mjs
│   │   │   │       ├── message-import-alias.can
│   │   │   │       ├── message-named.can
│   │   │   │       ├── message-param-default.can
│   │   │   │       ├── message-param-default.mjs
│   │   │   │       ├── message-param-named.can
│   │   │   │       ├── message-positional.can
│   │   │   │       ├── message-positional.mjs
│   │   │   │       ├── message-reversed.can
│   │   │   │       ├── missing-arg.can
│   │   │   │       ├── ordinary-eval-order.can
│   │   │   │       ├── ordinary-eval-order.mjs
│   │   │   │       ├── plain-eval-order.can
│   │   │   │       ├── plain-missing-reversed.can
│   │   │   │       ├── plain-named.can
│   │   │   │       ├── plain-positional.can
│   │   │   │       ├── plain-positional.mjs
│   │   │   │       ├── plain-reversed.can
│   │   │   │       ├── probe.mjs
│   │   │   │       ├── probe.py
│   │   │   │       ├── same-arity-awaited.can
│   │   │   │       ├── same-arity-awaited.mjs
│   │   │   │       ├── same-arity-later.can
│   │   │   │       ├── same-arity-later.mjs
│   │   │   │       ├── same-arity-selected-order.can
│   │   │   │       ├── same-arity-selected-order.mjs
│   │   │   │       └── unknown-name.can
│   │   │   ├── session-history/
│   │   │   │   ├── independent-review/
│   │   │   │   │   ├── observer.rs
│   │   │   │   │   └── review.md
│   │   │   │   ├── research/
│   │   │   │   │   └── probe.rs
│   │   │   │   ├── implementation.diff
│   │   │   │   └── selected-contract-proposal.md
│   │   │   ├── temporal-native-join-policy/
│   │   │   │   ├── context.md
│   │   │   │   └── decision.md
│   │   │   ├── temporal-presentation-join/
│   │   │   │   ├── date0001/
│   │   │   │   │   └── $can$m$54656d706f72616c50616765.mjs
│   │   │   │   ├── date0099/
│   │   │   │   │   └── $can$m$54656d706f72616c50616765.mjs
│   │   │   │   ├── date2001/
│   │   │   │   │   └── $can$m$54656d706f72616c50616765.mjs
│   │   │   │   ├── date2024/
│   │   │   │   │   └── $can$m$54656d706f72616c50616765.mjs
│   │   │   │   ├── decimal/
│   │   │   │   │   └── $can$m$54656d706f72616c50616765.mjs
│   │   │   │   ├── generated/
│   │   │   │   │   └── $can$m$54656d706f72616c50726573656e746174696f6e.mjs
│   │   │   │   ├── independent-review/
│   │   │   │   │   ├── REVIEW.md
│   │   │   │   │   └── public-controls.mjs
│   │   │   │   ├── instant/
│   │   │   │   │   └── $can$m$54656d706f72616c50616765.mjs
│   │   │   │   ├── integer/
│   │   │   │   │   └── $can$m$54656d706f72616c50616765.mjs
│   │   │   │   ├── intended-regression/
│   │   │   │   │   └── compiler/
│   │   │   │   │       └── tests/
│   │   │   │   │           ├── fixtures/
│   │   │   │   │           │   └── temporal-presentation/
│   │   │   │   │           │       ├── execute.mjs
│   │   │   │   │           │       └── source.can
│   │   │   │   │           └── temporal_presentation.rs
│   │   │   │   ├── model-wire-generated/
│   │   │   │   │   └── $can$m$54656d706f72616c57697265.mjs
│   │   │   │   ├── ordinal/
│   │   │   │   │   └── $can$m$54656d706f72616c50616765.mjs
│   │   │   │   ├── ui-freeze/
│   │   │   │   │   └── packages/
│   │   │   │   │       └── ui/
│   │   │   │   │           ├── src/
│   │   │   │   │           │   └── messages.ts
│   │   │   │   │           └── test/
│   │   │   │   │               └── messages.test.ts
│   │   │   │   ├── before.mjs
│   │   │   │   ├── date0001.can
│   │   │   │   ├── date0099.can
│   │   │   │   ├── date2001.can
│   │   │   │   ├── date2024.can
│   │   │   │   ├── decimal.can
│   │   │   │   ├── instant.can
│   │   │   │   ├── integer.can
│   │   │   │   ├── messages.test.before.ts
│   │   │   │   ├── model-wire.can
│   │   │   │   ├── model-wire.mjs
│   │   │   │   └── ordinal.can
│   │   │   ├── temporal-runtime/
│   │   │   │   ├── date0001/
│   │   │   │   │   └── $can$m$54656d706f72616c50616765.mjs
│   │   │   │   ├── date0099/
│   │   │   │   │   └── $can$m$54656d706f72616c50616765.mjs
│   │   │   │   ├── date2001/
│   │   │   │   │   └── $can$m$54656d706f72616c50616765.mjs
│   │   │   │   ├── date2024/
│   │   │   │   │   └── $can$m$54656d706f72616c50616765.mjs
│   │   │   │   ├── decimal/
│   │   │   │   │   └── $can$m$54656d706f72616c50616765.mjs
│   │   │   │   ├── instant/
│   │   │   │   │   └── $can$m$54656d706f72616c50616765.mjs
│   │   │   │   ├── integer/
│   │   │   │   │   └── $can$m$54656d706f72616c50616765.mjs
│   │   │   │   ├── ordinal/
│   │   │   │   │   └── $can$m$54656d706f72616c50616765.mjs
│   │   │   │   ├── ASSESSMENT.md
│   │   │   │   ├── MAPPING.md
│   │   │   │   ├── conversion-map.mjs
│   │   │   │   ├── date0001.can
│   │   │   │   ├── date0099.can
│   │   │   │   ├── date2001.can
│   │   │   │   ├── date2024.can
│   │   │   │   ├── decimal.can
│   │   │   │   ├── descriptor.can
│   │   │   │   ├── instant.can
│   │   │   │   ├── integer.can
│   │   │   │   ├── ordinal.can
│   │   │   │   ├── page.can
│   │   │   │   ├── probe.can
│   │   │   │   └── run.mjs
│   │   │   ├── temporal-values/
│   │   │   │   ├── decimal-literal-research/
│   │   │   │   │   ├── ASSESSMENT.md
│   │   │   │   │   ├── probe.mjs
│   │   │   │   │   └── public-module.mjs
│   │   │   │   ├── decimal-materialization/
│   │   │   │   │   ├── generated/
│   │   │   │   │   │   └── $can$m$4578616374.mjs
│   │   │   │   │   ├── independent-review/
│   │   │   │   │   │   └── REVIEW.md
│   │   │   │   │   ├── ASSESSMENT.md
│   │   │   │   │   ├── action-reference.can
│   │   │   │   │   ├── codegen.rs.before
│   │   │   │   │   ├── codegen.rs.patch
│   │   │   │   │   ├── decimal_runtime.rs.patch
│   │   │   │   │   ├── digits39.can
│   │   │   │   │   ├── execute.mjs
│   │   │   │   │   ├── js.rs.before
│   │   │   │   │   ├── js.rs.patch
│   │   │   │   │   ├── scale19.can
│   │   │   │   │   ├── selected.can
│   │   │   │   │   ├── selected.failed.can
│   │   │   │   │   └── unary-plus.can
│   │   │   │   ├── implementation/
│   │   │   │   │   └── compiler-source.diff
│   │   │   │   ├── independent-review/
│   │   │   │   │   └── qualification.md
│   │   │   │   └── research/
│   │   │   │       ├── date-0099/
│   │   │   │       │   └── $can$m$54.mjs
│   │   │   │       ├── date-current/
│   │   │   │       │   └── $can$m$54.mjs
│   │   │   │       ├── date-low/
│   │   │   │       │   └── $can$m$54.mjs
│   │   │   │       ├── datetime/
│   │   │   │       │   └── $can$m$54.mjs
│   │   │   │       ├── decimal-param/
│   │   │   │       │   └── $can$m$54.mjs
│   │   │   │       ├── ASSESSMENT.md
│   │   │   │       ├── control.mjs
│   │   │   │       ├── generated-date-0099.can
│   │   │   │       ├── generated-date-current.can
│   │   │   │       ├── generated-date-low.can
│   │   │   │       ├── generated-datetime.can
│   │   │   │       ├── generated-decimal-literal.can
│   │   │   │       ├── generated-decimal-param.can
│   │   │   │       ├── static-date-time.can
│   │   │   │       ├── static-decimal-integer.can
│   │   │   │       ├── static-decimal-ordinal.can
│   │   │   │       └── static-timezone-mars.can
│   │   │   ├── ui-ownership/
│   │   │   │   ├── independent-review/
│   │   │   │   │   ├── nested-row.can
│   │   │   │   │   ├── nested-row.emitted.mjs
│   │   │   │   │   ├── protocol-controls.mjs
│   │   │   │   │   ├── review.md
│   │   │   │   │   ├── static-consume.mjs
│   │   │   │   │   ├── static-emitted.mjs
│   │   │   │   │   └── static.can
│   │   │   │   ├── research/
│   │   │   │   │   ├── selected-phase/
│   │   │   │   │   │   ├── card-control.mjs
│   │   │   │   │   │   ├── consume.mjs
│   │   │   │   │   │   ├── order.mjs
│   │   │   │   │   │   └── tab.mjs
│   │   │   │   │   ├── card-control.can
│   │   │   │   │   ├── card-control.mjs
│   │   │   │   │   ├── consume.mjs
│   │   │   │   │   ├── contract.md
│   │   │   │   │   ├── kbd.can
│   │   │   │   │   ├── mystery.can
│   │   │   │   │   ├── order.can
│   │   │   │   │   ├── order.mjs
│   │   │   │   │   ├── tab.can
│   │   │   │   │   └── tab.mjs
│   │   │   │   └── tab-policy/
│   │   │   │       └── closure.md
│   │   │   ├── view-reuse/
│   │   │   │   ├── README.md
│   │   │   │   ├── agenda-consumer.mjs
│   │   │   │   ├── consumer.mjs
│   │   │   │   ├── history-consumer.mjs
│   │   │   │   ├── table-filter-consumer.mjs
│   │   │   │   ├── table-order-consumer.mjs
│   │   │   │   └── table-time-consumer.mjs
│   │   │   └── width-boundaries/
│   │   │       └── README.md
│   │   ├── description-reference-run/
│   │   │   ├── evidence/
│   │   │   │   └── integration.md
│   │   │   └── review.md
│   │   ├── evidence/
│   │   │   ├── lane-01-b1/
│   │   │   │   ├── phase2.md
│   │   │   │   └── runtime.md
│   │   │   ├── b2-follow-through.md
│   │   │   ├── b3-i1.md
│   │   │   ├── b3-i2.md
│   │   │   ├── b3-i3.md
│   │   │   ├── b3-i4.md
│   │   │   ├── b3-i5.md
│   │   │   ├── b3-i6.md
│   │   │   ├── b4-draft-defects.md
│   │   │   ├── b4-f1.md
│   │   │   ├── b4-f2.md
│   │   │   ├── b4-f3.md
│   │   │   ├── b4-f4.md
│   │   │   ├── b4-proposals.md
│   │   │   ├── b5-j1.md
│   │   │   ├── b5-j2.md
│   │   │   ├── b5-j3.md
│   │   │   ├── mcp-p1.md
│   │   │   ├── mcp-p2.md
│   │   │   ├── mcp-p3.md
│   │   │   ├── mcp-p4.md
│   │   │   ├── mcpd-a.md
│   │   │   ├── mcpd-b.md
│   │   │   └── mcpd-c.md
│   │   ├── installed-worker-assets/
│   │   │   └── README.md
│   │   ├── lean-install/
│   │   │   ├── README.md
│   │   │   ├── local-bindings.md
│   │   │   ├── notices.md
│   │   │   └── website-handoff.md
│   │   ├── package-boundaries-probe/
│   │   │   ├── evidence/
│   │   │   │   ├── boundaries/
│   │   │   │   │   └── RESULTS.md
│   │   │   │   ├── native/
│   │   │   │   │   ├── fixtures/
│   │   │   │   │   │   ├── named-control/
│   │   │   │   │   │   │   └── AGENTS.md
│   │   │   │   │   │   ├── nested-control/
│   │   │   │   │   │   │   └── AGENTS.md
│   │   │   │   │   │   ├── root-control/
│   │   │   │   │   │   │   └── AGENTS.md
│   │   │   │   │   │   └── same-name-control/
│   │   │   │   │   │       └── AGENTS.md
│   │   │   │   │   └── README.md
│   │   │   │   └── review/
│   │   │   │       ├── cold-fixture/
│   │   │   │       │   └── AGENTS.md
│   │   │   │       └── ASSESSMENT.md
│   │   │   └── README.md
│   │   ├── package-boundary-repair/
│   │   │   ├── evidence/
│   │   │   │   ├── installed-verify.mjs
│   │   │   │   └── no-testkit.mjs
│   │   │   └── README.md
│   │   ├── package-maintenance-repair/
│   │   │   ├── runs/
│   │   │   │   └── codex-go-20261007/
│   │   │   │       ├── h1-placement-advice/
│   │   │   │       │   └── reconciliation.md
│   │   │   │       ├── security-contract/
│   │   │   │       │   ├── crud-public-advice.md
│   │   │   │       │   └── disposition.md
│   │   │   │       ├── asset-mount-contract.json
│   │   │   │       ├── h1-owning-contract.json
│   │   │   │       └── owned-content-contract.json
│   │   │   └── README.md
│   │   ├── rust-port-orchestration/
│   │   │   ├── contracts-20261007/
│   │   │   │   ├── oracles/
│   │   │   │   │   ├── frozen-generator.mjs
│   │   │   │   │   └── frozen-oracle.json.gz
│   │   │   │   ├── README.md
│   │   │   │   ├── decision-record.md
│   │   │   │   ├── delivery-contracts.json
│   │   │   │   ├── imports.md
│   │   │   │   ├── independent-review.md
│   │   │   │   ├── numeric-common.md
│   │   │   │   ├── numeric-contracts.json
│   │   │   │   ├── numeric-values.md
│   │   │   │   ├── numeric-work.md
│   │   │   │   ├── sourcemaps-raw.md
│   │   │   │   └── strings-rust.md
│   │   │   ├── first-packets-20261007/
│   │   │   │   ├── README.md
│   │   │   │   ├── independent-review.md
│   │   │   │   ├── residual-decisions.md
│   │   │   │   └── technical-readiness.md
│   │   │   ├── preflight-20261007/
│   │   │   │   └── reviews/
│   │   │   │       ├── values-validation.md
│   │   │   │       └── work-delivery.md
│   │   │   ├── runs/
│   │   │   │   ├── codex-first-20261006T231809Z/
│   │   │   │   │   └── README.md
│   │   │   │   ├── codex-n04-20261006T233602Z/
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── independent-review.md
│   │   │   │   ├── codex-step10-20261007T015711Z/
│   │   │   │   │   ├── contracts/
│   │   │   │   │   │   ├── csv-contract.md
│   │   │   │   │   │   ├── identity-cookie-contract.md
│   │   │   │   │   │   ├── identity-cookie-probe.mjs
│   │   │   │   │   │   ├── identity-encoding-contract.md
│   │   │   │   │   │   ├── identity-encoding-probe.mjs
│   │   │   │   │   │   ├── identity-host-callers-probe.mjs
│   │   │   │   │   │   ├── identity-host-contract.md
│   │   │   │   │   │   └── identity-host-probe.mjs
│   │   │   │   │   ├── reviews/
│   │   │   │   │   │   ├── C-H-independent-review.md
│   │   │   │   │   │   ├── C04-export-evaluation.md
│   │   │   │   │   │   ├── I03-critical-review.md
│   │   │   │   │   │   ├── ROOT-FINAL-ACCEPTANCE.md
│   │   │   │   │   │   └── W03.2-ref-carrier.md
│   │   │   │   │   ├── DECISIONS-PENDING-HANDOFF.md
│   │   │   │   │   └── README.md
│   │   │   │   ├── codex-step11-20261007T024618Z/
│   │   │   │   │   ├── DECISIONS-PENDING-HANDOFF.md
│   │   │   │   │   ├── E01-RETAIN-NOW.md
│   │   │   │   │   ├── MECHANICAL-REVIEW.md
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── historical-caller-switch.diff
│   │   │   │   ├── codex-step12-20261007T025830Z/
│   │   │   │   │   ├── raw/
│   │   │   │   │   │   ├── astra/
│   │   │   │   │   │   │   ├── deploy/
│   │   │   │   │   │   │   │   ├── module-imports.mjs
│   │   │   │   │   │   │   │   └── module-maps.mjs
│   │   │   │   │   │   │   ├── runtime/
│   │   │   │   │   │   │   │   └── sourcemap.mjs
│   │   │   │   │   │   │   └── probe.mjs
│   │   │   │   │   │   ├── build.mjs
│   │   │   │   │   │   ├── diagnostic-probe.mjs
│   │   │   │   │   │   ├── policy-check.mjs
│   │   │   │   │   │   └── staged-byte-delta.diff
│   │   │   │   │   ├── reviews/
│   │   │   │   │   │   ├── ASTRA-CRITICAL.md
│   │   │   │   │   │   └── SOL-QUALIFICATION.md
│   │   │   │   │   ├── ASTRA-REVIEW-PACKET.md
│   │   │   │   │   ├── DECISIONS-PENDING-HANDOFF.md
│   │   │   │   │   ├── README.md
│   │   │   │   │   ├── REMAINING.md
│   │   │   │   │   └── REVIEW-SCOPE.md
│   │   │   │   ├── codex-step6-20261006T235151Z/
│   │   │   │   │   ├── DECISIONS-PENDING-HANDOFF.md
│   │   │   │   │   └── README.md
│   │   │   │   ├── codex-step7-20261007T002305Z/
│   │   │   │   │   ├── DECISIONS-PENDING-HANDOFF.md
│   │   │   │   │   └── README.md
│   │   │   │   ├── codex-step8-20261007T005702Z/
│   │   │   │   │   ├── DECISIONS-PENDING-HANDOFF.md
│   │   │   │   │   ├── README.md
│   │   │   │   │   ├── independent-source-review.md
│   │   │   │   │   └── reviewed-lock.diff
│   │   │   │   └── codex-step9-20261007T012914Z/
│   │   │   │       ├── DECISIONS-PENDING-HANDOFF.md
│   │   │   │       ├── README.md
│   │   │   │       ├── independent-installed-values.mjs
│   │   │   │       └── qualify-work-readiness.mjs
│   │   │   ├── ACTIVATION-TEMPLATE.txt
│   │   │   ├── BOOTSTRAP-TEMPLATE.txt
│   │   │   └── GO-TEMPLATE.txt
│   │   ├── turbo-scheduling/
│   │   │   └── README.md
│   │   ├── CONTRACTS.md
│   │   ├── D3B-OBSERVER-SEAM-CONTRACT.md
│   │   ├── DESCRIPTION-REFERENCE-PLAN.md
│   │   ├── DESIGN-DELTA-20261004.md
│   │   ├── DIAGNOSTICS.md
│   │   ├── OVERLAP-INVENTORY.md
│   │   ├── PACKAGE-BOUNDARIES-AND-TURBO.md
│   │   ├── REMAINING-WORK.md
│   │   └── UI-CATALOG-ADOPTION.md
│   ├── public/
│   │   ├── 01-Get-started/
│   │   │   ├── 01-index.md
│   │   │   ├── 02-example-progression.md
│   │   │   ├── 03-installation.md
│   │   │   ├── 04-editor-support.md
│   │   │   ├── 05-first-app.md
│   │   │   ├── 06-local-development.md
│   │   │   ├── 07-first-workflow.md
│   │   │   └── 08-ai-authoring.md
│   │   ├── 02-Language-foundations/
│   │   │   ├── 01-source-syntax.md
│   │   │   ├── 02-types-and-values.md
│   │   │   ├── 03-expressions-and-derives.md
│   │   │   ├── 04-apps-and-packages.md
│   │   │   ├── 05-context-and-defaults.md
│   │   │   └── 06-descriptions-and-app-reference.md
│   │   ├── 03-Generate-implementation/
│   │   │   ├── 01-generation-lifecycle.md
│   │   │   ├── 02-traits-and-custom-keywords.md
│   │   │   ├── 03-styles-and-custom-views.md
│   │   │   └── 04-editing-and-refinement.md
│   │   ├── 04-Model-and-query-data/
│   │   │   ├── 01-models-and-relationships.md
│   │   │   ├── 02-defaults-and-validation.md
│   │   │   ├── 03-queries-and-aggregates.md
│   │   │   ├── 04-money-and-currency.md
│   │   │   ├── 05-dates-and-timezones.md
│   │   │   └── 06-history-and-retention.md
│   │   ├── 05-Permissions-and-policy/
│   │   │   ├── 01-authentication-and-teams.md
│   │   │   ├── 02-read-policies-and-field-access.md
│   │   │   ├── 03-roles-and-operation-permissions.md
│   │   │   ├── 04-invariants-and-locks.md
│   │   │   └── 05-reviewing-business-policy.md
│   │   ├── 06-Business-workflows/
│   │   │   ├── 01-crud-and-record-lifecycle.md
│   │   │   ├── 02-scenarios-and-effects.md
│   │   │   ├── 03-transactions-and-concurrency.md
│   │   │   ├── 04-state-machines.md
│   │   │   ├── 05-actions-and-invocations.md
│   │   │   ├── 06-events-and-hooks.md
│   │   │   ├── 07-scheduling-and-recurring-work.md
│   │   │   └── 08-fanout-and-batch-work.md
│   │   ├── 07-Build-interfaces/
│   │   │   ├── 01-pages-and-navigation.md
│   │   │   ├── 02-components-and-layout.md
│   │   │   ├── 03-collections-and-views.md
│   │   │   ├── 04-forms-and-inputs.md
│   │   │   ├── 05-settings-and-preferences.md
│   │   │   ├── 06-localization.md
│   │   │   ├── 07-csv-import.md
│   │   │   ├── 08-export-and-print.md
│   │   │   └── 09-live-pages-and-progress.md
│   │   ├── 08-Connect-services/
│   │   │   ├── 01-contracts-and-service-bindings.md
│   │   │   ├── 02-deliveries-and-recovery.md
│   │   │   ├── 03-files-and-attachments.md
│   │   │   ├── 04-email-and-mailboxes.md
│   │   │   ├── 05-payments.md
│   │   │   ├── 06-external-data-and-app-connections.md
│   │   │   └── 07-mcp.md
│   │   ├── 09-Runtime-AI/
│   │   │   ├── 01-text-and-image-generation.md
│   │   │   ├── 02-judgments.md
│   │   │   └── 03-knowledge-corpora.md
│   │   ├── 10-Recipes/
│   │   │   ├── 01-approval-workflow.md
│   │   │   ├── 02-resource-booking.md
│   │   │   ├── 03-reminders-and-escalation.md
│   │   │   ├── 04-external-sync.md
│   │   │   ├── 05-reviewed-ai-actions.md
│   │   │   ├── 06-private-knowledge-assistant.md
│   │   │   └── 07-composed-business-app.md
│   │   ├── 11-Verify-and-build/
│   │   │   ├── 01-diagnostics-and-help.md
│   │   │   ├── 02-fixtures-and-examples.md
│   │   │   ├── 03-builds-and-validation.md
│   │   │   ├── 04-workflow-and-interface-testing.md
│   │   │   └── 05-continuous-integration.md
│   │   ├── 12-Deploy-and-operate/
│   │   │   ├── 01-environments-and-secrets.md
│   │   │   ├── 02-deploying-an-app.md
│   │   │   ├── 03-schema-migrations.md
│   │   │   ├── 04-upgrades-and-recovery.md
│   │   │   ├── 05-operating-an-app.md
│   │   │   └── 06-instrumentation.md
│   │   ├── 13-Language-reference/
│   │   │   ├── 01-syntax-reference.md
│   │   │   ├── 02-types-and-builtins.md
│   │   │   ├── 03-errors-and-wire-values.md
│   │   │   └── 04-service-contracts.md
│   │   ├── 14-Component-reference/
│   │   │   ├── 01-components-layout-and-navigation.md
│   │   │   ├── 02-components-content-and-feedback.md
│   │   │   ├── 03-components-inputs.md
│   │   │   ├── 04-components-disclosure-and-actions.md
│   │   │   └── 05-components-collections-and-media.md
│   │   ├── 15-Tooling-reference/
│   │   │   ├── 01-cli.md
│   │   │   ├── 02-development-controls.md
│   │   │   ├── 03-generation-configuration.md
│   │   │   └── 04-generation-controls.md
│   │   ├── examples/
│   │   │   ├── account-lookup/
│   │   │   │   ├── Accounts.can
│   │   │   │   └── Lookup.can
│   │   │   ├── builtin-lookup/
│   │   │   │   └── BuiltinLookup.can
│   │   │   ├── component-tasks/
│   │   │   │   └── ComponentTasks.can
│   │   │   ├── files-mail-payments/
│   │   │   │   ├── MailReplies.can
│   │   │   │   ├── PaymentDemo.can
│   │   │   │   ├── ReceiptFiles.can
│   │   │   │   └── receipt-sample.txt
│   │   │   ├── interface-tasks/
│   │   │   │   ├── InterfaceTasks.can
│   │   │   │   └── tasks.csv
│   │   │   ├── recipes/
│   │   │   │   ├── Bookings.can
│   │   │   │   ├── ExpenseFlow.can
│   │   │   │   ├── ExternalSync.can
│   │   │   │   └── Reminders.can
│   │   │   ├── runtime-ai/
│   │   │   │   ├── ImageReview.can
│   │   │   │   ├── JudgmentReview.can
│   │   │   │   ├── KnowledgeReview.can
│   │   │   │   └── TextReview.can
│   │   │   ├── task-forms/
│   │   │   │   └── TaskForms.can
│   │   │   ├── task-pages/
│   │   │   │   └── TaskPages.can
│   │   │   ├── task-preferences/
│   │   │   │   ├── TaskMail.can
│   │   │   │   └── TaskPreferences.can
│   │   │   ├── team-office/
│   │   │   │   ├── packages/
│   │   │   │   │   ├── Notes.can
│   │   │   │   │   └── Tasks.can
│   │   │   │   └── Office.can
│   │   │   └── verified-tasks/
│   │   │       └── VerifiedTasks.can
│   │   ├── FILETREE.md
│   │   └── README.md
│   ├── recovery/
│   │   └── canleave-fe2502e-source.patch
│   ├── research/
│   │   ├── compiler-library-audit-20261006/
│   │   │   ├── evidence/
│   │   │   │   ├── codegen/
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── string-and-columns-probe.rs
│   │   │   │   ├── protocol-cli/
│   │   │   │   │   └── probe.py
│   │   │   │   └── syntax-analysis/
│   │   │   │       ├── README.md
│   │   │   │       ├── host-parity.mjs
│   │   │   │       ├── locale-probe.rs
│   │   │   │       └── url-probe.rs
│   │   │   ├── pass0/
│   │   │   │   ├── evidence/
│   │   │   │   │   ├── protocol/
│   │   │   │   │   │   ├── parser-probe.rs
│   │   │   │   │   │   └── probe.py
│   │   │   │   │   ├── root/
│   │   │   │   │   │   ├── boundary-probe.rs
│   │   │   │   │   │   └── map-probe.mjs
│   │   │   │   │   └── values/
│   │   │   │   │       └── export-probe.mjs
│   │   │   │   ├── README.md
│   │   │   │   ├── protocol-contracts.md
│   │   │   │   └── value-contracts.md
│   │   │   ├── pass1/
│   │   │   │   └── README.md
│   │   │   ├── pass10/
│   │   │   │   ├── checks/
│   │   │   │   │   └── README.md
│   │   │   │   ├── consumers/
│   │   │   │   │   ├── artifacts/
│   │   │   │   │   │   ├── current-emitted/
│   │   │   │   │   │   │   ├── shop.mjs
│   │   │   │   │   │   │   └── shop.mjs.map
│   │   │   │   │   │   ├── installed-emitted/
│   │   │   │   │   │   │   ├── shop.mjs
│   │   │   │   │   │   │   └── shop.mjs.map
│   │   │   │   │   │   ├── bad.can
│   │   │   │   │   │   └── wire.can
│   │   │   │   │   ├── README.md
│   │   │   │   │   ├── artifact-probe.mjs
│   │   │   │   │   ├── prepare.py
│   │   │   │   │   ├── probe.py
│   │   │   │   │   └── replay.sh
│   │   │   │   ├── format/
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── rustfmt.diff
│   │   │   │   ├── profile/
│   │   │   │   │   └── README.md
│   │   │   │   ├── review/
│   │   │   │   │   ├── final-review.md
│   │   │   │   │   └── retirement.md
│   │   │   │   ├── workload/
│   │   │   │   │   ├── ExpenseFlow.can
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── cli-cost.py
│   │   │   │   ├── CONTRACT.md
│   │   │   │   └── README.md
│   │   │   ├── pass2/
│   │   │   │   ├── consultation/
│   │   │   │   │   └── assessment.md
│   │   │   │   ├── README.md
│   │   │   │   ├── contract.md
│   │   │   │   └── numeric-oracle.py
│   │   │   ├── pass3/
│   │   │   │   ├── locale/
│   │   │   │   │   ├── src/
│   │   │   │   │   │   └── main.rs
│   │   │   │   │   ├── Cargo.lock
│   │   │   │   │   ├── Cargo.toml
│   │   │   │   │   ├── independent-review.md
│   │   │   │   │   └── probe.mjs
│   │   │   │   ├── url/
│   │   │   │   │   ├── src/
│   │   │   │   │   │   └── main.rs
│   │   │   │   │   ├── Cargo.lock
│   │   │   │   │   ├── Cargo.toml
│   │   │   │   │   ├── public-probe.mjs
│   │   │   │   │   ├── qualification.md
│   │   │   │   │   ├── release-probe.py
│   │   │   │   │   ├── rust-results.tsv
│   │   │   │   │   └── vectors.json
│   │   │   │   └── README.md
│   │   │   ├── pass4/
│   │   │   │   ├── consultation/
│   │   │   │   │   └── assessment.md
│   │   │   │   ├── files/
│   │   │   │   │   ├── README.md
│   │   │   │   │   ├── contract.md
│   │   │   │   │   ├── integrated-Cargo.lock
│   │   │   │   │   └── integrated-Cargo.toml
│   │   │   │   ├── hash/
│   │   │   │   │   ├── README.md
│   │   │   │   │   ├── integrated-Cargo.lock
│   │   │   │   │   ├── integrated-Cargo.toml
│   │   │   │   │   ├── scratch-Cargo.lock
│   │   │   │   │   └── vectors.json
│   │   │   │   └── README.md
│   │   │   ├── pass5/
│   │   │   │   ├── consultation/
│   │   │   │   │   └── assessment.md
│   │   │   │   ├── diagnostics/
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── contract.md
│   │   │   │   ├── families/
│   │   │   │   │   ├── artifact.md
│   │   │   │   │   ├── bdd.md
│   │   │   │   │   ├── descriptors.md
│   │   │   │   │   ├── explain.md
│   │   │   │   │   ├── fixes.md
│   │   │   │   │   ├── policy.md
│   │   │   │   │   └── references.md
│   │   │   │   ├── profile/
│   │   │   │   │   └── README.md
│   │   │   │   ├── README.md
│   │   │   │   ├── family-review.md
│   │   │   │   └── final-review.md
│   │   │   ├── pass6/
│   │   │   │   ├── benchmark/
│   │   │   │   │   ├── initial/
│   │   │   │   │   │   └── report.md
│   │   │   │   │   ├── loaded-correction/
│   │   │   │   │   │   └── report.md
│   │   │   │   │   ├── Cargo.lock
│   │   │   │   │   ├── Cargo.toml
│   │   │   │   │   ├── README.md
│   │   │   │   │   ├── main.rs
│   │   │   │   │   └── report.md
│   │   │   │   ├── consultation/
│   │   │   │   │   └── assessment.md
│   │   │   │   ├── CONTRACT.md
│   │   │   │   ├── README.md
│   │   │   │   ├── caller-contract-review.md
│   │   │   │   ├── candidate-report.md
│   │   │   │   └── review.md
│   │   │   ├── pass7/
│   │   │   │   ├── consultation/
│   │   │   │   │   └── assessment.md
│   │   │   │   ├── profile/
│   │   │   │   │   └── README.md
│   │   │   │   ├── CONTRACT.md
│   │   │   │   ├── README.md
│   │   │   │   ├── output-inventory.md
│   │   │   │   ├── review.md
│   │   │   │   ├── uri-investigation.md
│   │   │   │   └── uri-vector-probe.rs
│   │   │   ├── pass8/
│   │   │   │   ├── consumer/
│   │   │   │   │   ├── consumer.ts
│   │   │   │   │   ├── current-source-witness.rs
│   │   │   │   │   ├── qualification.md
│   │   │   │   │   ├── raw-contract.ts
│   │   │   │   │   └── replay.sh
│   │   │   │   ├── library/
│   │   │   │   │   ├── probe.rs
│   │   │   │   │   └── registration-probe.rs
│   │   │   │   ├── profile/
│   │   │   │   │   ├── cost/
│   │   │   │   │   │   └── ExpenseFlow.can
│   │   │   │   │   └── README.md
│   │   │   │   ├── CONTRACT.md
│   │   │   │   ├── README.md
│   │   │   │   └── review.md
│   │   │   ├── pass9/
│   │   │   │   ├── cli/
│   │   │   │   │   ├── assessment.md
│   │   │   │   │   ├── candidate-Cargo.lock
│   │   │   │   │   ├── candidate-Cargo.toml
│   │   │   │   │   ├── candidate-bash-probe.sh
│   │   │   │   │   ├── candidate.bash
│   │   │   │   │   ├── candidate.fish
│   │   │   │   │   ├── candidate.py
│   │   │   │   │   ├── candidate.zsh
│   │   │   │   │   ├── clap-prototype.rs
│   │   │   │   │   ├── clap_complete-4.6.7-Cargo.toml
│   │   │   │   │   ├── completion-probe.sh
│   │   │   │   │   ├── correctness-queue.md
│   │   │   │   │   ├── probe.py
│   │   │   │   │   ├── zsh-probe.zsh
│   │   │   │   │   └── zsh-pty.py
│   │   │   │   ├── consultation/
│   │   │   │   │   └── README.md
│   │   │   │   ├── correctness/
│   │   │   │   │   ├── QUEUE.md
│   │   │   │   │   ├── completion-CONTRACT.md
│   │   │   │   │   └── position-CONTRACT.md
│   │   │   │   ├── graphs/
│   │   │   │   │   ├── ASSESSMENT.md
│   │   │   │   │   ├── candidate.Cargo.lock
│   │   │   │   │   ├── candidate.Cargo.toml
│   │   │   │   │   ├── compiler_probe.rs
│   │   │   │   │   ├── graph_probe.rs
│   │   │   │   │   └── reproduce.sh
│   │   │   │   ├── icu/
│   │   │   │   │   ├── fixtures/
│   │   │   │   │   │   ├── cardinal-decimal.can
│   │   │   │   │   │   ├── cardinal-int.can
│   │   │   │   │   │   ├── integer-decimal.can
│   │   │   │   │   │   ├── integer-int.can
│   │   │   │   │   │   ├── number-decimal.can
│   │   │   │   │   │   ├── number-int.can
│   │   │   │   │   │   ├── ordinal-decimal.can
│   │   │   │   │   │   └── ordinal-int.can
│   │   │   │   │   ├── README.md
│   │   │   │   │   ├── candidate-assessment.md
│   │   │   │   │   ├── correctness-packets.md
│   │   │   │   │   ├── crate-index.jsonl
│   │   │   │   │   ├── formatjs-0.3.1.crate
│   │   │   │   │   ├── hook-built.mjs
│   │   │   │   │   ├── hook.mjs
│   │   │   │   │   ├── owner-snapshot.tar.gz
│   │   │   │   │   ├── parity.mjs
│   │   │   │   │   ├── render.mjs
│   │   │   │   │   ├── replay.sh
│   │   │   │   │   ├── structure.mjs
│   │   │   │   │   └── verify-results.mjs
│   │   │   │   ├── positions/
│   │   │   │   │   ├── current.rs
│   │   │   │   │   ├── line-index-0.1.2-Cargo.toml
│   │   │   │   │   ├── line-index-0.1.2-lib.rs
│   │   │   │   │   ├── line-index-0.1.2.crate
│   │   │   │   │   ├── nohash-hasher-0.2.0-Cargo.toml
│   │   │   │   │   ├── nohash-hasher-0.2.0-lib.rs
│   │   │   │   │   ├── nohash-hasher-0.2.0.crate
│   │   │   │   │   ├── path-adapter.rs
│   │   │   │   │   ├── path-clean-1.0.1-Cargo.toml
│   │   │   │   │   ├── path-clean-1.0.1-lib.rs
│   │   │   │   │   ├── path-clean-1.0.1.crate
│   │   │   │   │   ├── replay-path.sh
│   │   │   │   │   ├── replay.py
│   │   │   │   │   ├── rlib.rs
│   │   │   │   │   ├── text-size-1.1.1-Cargo.toml
│   │   │   │   │   ├── text-size-1.1.1-lib.rs
│   │   │   │   │   ├── text-size-1.1.1.crate
│   │   │   │   │   └── vectors.json
│   │   │   │   ├── positions-medium/
│   │   │   │   │   ├── ASSESSMENT.md
│   │   │   │   │   ├── fixed.rs
│   │   │   │   │   ├── identity-probe.rs
│   │   │   │   │   ├── line-adapter.rs
│   │   │   │   │   ├── replay.py
│   │   │   │   │   ├── supplement.rs
│   │   │   │   │   └── vectors.json
│   │   │   │   ├── profile/
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── source-snapshot.tar.gz
│   │   │   │   ├── review/
│   │   │   │   │   ├── completion-position-review.md
│   │   │   │   │   ├── graph-position-comparison-review.md
│   │   │   │   │   └── substantive-review.md
│   │   │   │   ├── temporal/
│   │   │   │   │   ├── ASSESSMENT.md
│   │   │   │   │   ├── candidate-Cargo.lock
│   │   │   │   │   ├── candidate-Cargo.toml
│   │   │   │   │   ├── candidate.rs
│   │   │   │   │   ├── replay-candidate.py
│   │   │   │   │   ├── replay.mjs
│   │   │   │   │   └── vectors.json
│   │   │   │   ├── PACKETS.md
│   │   │   │   ├── README.md
│   │   │   │   └── dispatch.md
│   │   │   ├── production-reduction/
│   │   │   │   ├── README.md
│   │   │   │   └── lsp-review.md
│   │   │   ├── responsibility-map/
│   │   │   │   ├── editor-evidence/
│   │   │   │   │   ├── attempt1/
│   │   │   │   │   │   ├── probe.rs
│   │   │   │   │   │   ├── process-cases.json
│   │   │   │   │   │   ├── process.py
│   │   │   │   │   │   └── run.py
│   │   │   │   │   ├── client-notes.md
│   │   │   │   │   ├── client-probe.cjs
│   │   │   │   │   ├── client-run.py
│   │   │   │   │   ├── probe.rs
│   │   │   │   │   ├── process-cases.json
│   │   │   │   │   ├── process.py
│   │   │   │   │   ├── review-client.md
│   │   │   │   │   ├── review-integration.md
│   │   │   │   │   ├── review-process.md
│   │   │   │   │   ├── review-server.md
│   │   │   │   │   ├── run.py
│   │   │   │   │   ├── server-notes.md
│   │   │   │   │   └── server-options.py
│   │   │   │   ├── failure-evidence/
│   │   │   │   │   ├── attempt1/
│   │   │   │   │   │   └── probe.rs
│   │   │   │   │   ├── admission.md
│   │   │   │   │   ├── algorithms.md
│   │   │   │   │   ├── files-cases.json
│   │   │   │   │   ├── files-probe.py
│   │   │   │   │   ├── files.md
│   │   │   │   │   ├── hazard-scan.py
│   │   │   │   │   ├── probe.rs
│   │   │   │   │   ├── resource-cases.json
│   │   │   │   │   ├── resource-probe.py
│   │   │   │   │   ├── review-admission.md
│   │   │   │   │   ├── review-files.md
│   │   │   │   │   ├── review-resources.md
│   │   │   │   │   ├── run.py
│   │   │   │   │   ├── source-flat-1024.can
│   │   │   │   │   ├── source-flat-2048.can
│   │   │   │   │   ├── source-flat-256.can
│   │   │   │   │   ├── source-flat-3000.can
│   │   │   │   │   ├── source-flat-512.can
│   │   │   │   │   └── source-flat-64.can
│   │   │   │   ├── output-evidence/
│   │   │   │   │   ├── cases-initial.json
│   │   │   │   │   ├── cases.json
│   │   │   │   │   ├── cli-cases.json
│   │   │   │   │   ├── cli.py
│   │   │   │   │   ├── identifier-await-0.mjs
│   │   │   │   │   ├── identifier-c-0.mjs
│   │   │   │   │   ├── identifier-class-0.mjs
│   │   │   │   │   ├── identifier-default-0.mjs
│   │   │   │   │   ├── identifier-value-0.mjs
│   │   │   │   │   ├── integrate.py
│   │   │   │   │   ├── probe-attempt1.rs
│   │   │   │   │   ├── probe.rs
│   │   │   │   │   ├── review-transforms.md
│   │   │   │   │   ├── run.py
│   │   │   │   │   └── serialization-notes.md
│   │   │   │   ├── representation-evidence/
│   │   │   │   │   └── provenance/
│   │   │   │   │       ├── attempt1.probe.rs
│   │   │   │   │       └── probe.rs
│   │   │   │   ├── semantic-evidence/
│   │   │   │   │   ├── README.md
│   │   │   │   │   ├── authority-notes.md
│   │   │   │   │   ├── cases.json
│   │   │   │   │   ├── cli.py
│   │   │   │   │   ├── extend.py
│   │   │   │   │   ├── extra-cases.json
│   │   │   │   │   ├── final-review.md
│   │   │   │   │   ├── generated-format.mjs
│   │   │   │   │   ├── generated.py
│   │   │   │   │   ├── integrate.py
│   │   │   │   │   ├── owner.mjs
│   │   │   │   │   ├── probe.rs
│   │   │   │   │   ├── resolution-notes.md
│   │   │   │   │   ├── review-authority.md
│   │   │   │   │   ├── review-resolution.md
│   │   │   │   │   ├── review-values.md
│   │   │   │   │   ├── run.py
│   │   │   │   │   └── values-notes.md
│   │   │   │   ├── syntax-evidence/
│   │   │   │   │   ├── README.md
│   │   │   │   │   ├── byte_cli.py
│   │   │   │   │   ├── cases.json
│   │   │   │   │   ├── cross-review-notes.md
│   │   │   │   │   ├── extend.py
│   │   │   │   │   ├── extra-cases.json
│   │   │   │   │   ├── forms-review-notes.md
│   │   │   │   │   ├── inventory-notes.md
│   │   │   │   │   ├── probe.rs
│   │   │   │   │   ├── recovery-notes.md
│   │   │   │   │   └── run.py
│   │   │   │   ├── README.md
│   │   │   │   ├── compatibility.md
│   │   │   │   ├── editor.md
│   │   │   │   ├── failure.md
│   │   │   │   ├── integrations.md
│   │   │   │   ├── outputs.md
│   │   │   │   ├── representations.md
│   │   │   │   ├── semantics.md
│   │   │   │   ├── syntax.md
│   │   │   │   └── workflows.md
│   │   │   ├── resumption/
│   │   │   │   ├── flat-evidence/
│   │   │   │   │   └── arithmetic-runtime.mjs
│   │   │   │   ├── README.md
│   │   │   │   ├── audit-costs-and-oracles.md
│   │   │   │   ├── bdd-sequence-review.md
│   │   │   │   ├── binding-review.md
│   │   │   │   ├── cost-probe.py
│   │   │   │   ├── final-independent-review.md
│   │   │   │   ├── final-test-accounting.md
│   │   │   │   ├── flat-arithmetic-review.md
│   │   │   │   ├── flat-stages.rs
│   │   │   │   ├── independent-priorities.md
│   │   │   │   ├── lowering-and-execution.md
│   │   │   │   ├── lsp-and-client-review.md
│   │   │   │   └── rename-review.md
│   │   │   ├── README.md
│   │   │   ├── compiler-correctness-simplicity-audit.md
│   │   │   └── implementation-passes.md
│   │   ├── package-library-audit-20261006/
│   │   │   ├── adapter-branches/
│   │   │   │   ├── README.md
│   │   │   │   ├── branches.jsonl
│   │   │   │   ├── decision-record.md
│   │   │   │   ├── integration-crosswalk.tsv
│   │   │   │   ├── review.md
│   │   │   │   └── syntax-sites.jsonl
│   │   │   ├── control-lifecycle/
│   │   │   │   ├── README.md
│   │   │   │   ├── duty-coverage.tsv
│   │   │   │   ├── file-coverage.tsv
│   │   │   │   ├── fix-queue.json
│   │   │   │   ├── inventory.md
│   │   │   │   ├── proposed-decisions.md
│   │   │   │   └── resources.jsonl
│   │   │   ├── data-protocol/
│   │   │   │   ├── README.md
│   │   │   │   ├── coverage.tsv
│   │   │   │   ├── fix-queue.json
│   │   │   │   ├── proposed-decisions.md
│   │   │   │   ├── reference-witnesses.mjs
│   │   │   │   └── witnesses.jsonl
│   │   │   ├── dependency-runtime/
│   │   │   │   ├── README.md
│   │   │   │   ├── asset-probe.mjs
│   │   │   │   ├── cold-probe.mjs
│   │   │   │   ├── counter-review.md
│   │   │   │   ├── execution-matrix.jsonl
│   │   │   │   └── upgrade-risks.jsonl
│   │   │   ├── duplication-layers/
│   │   │   │   ├── README.md
│   │   │   │   ├── candidate-list.md
│   │   │   │   ├── candidates.jsonl
│   │   │   │   ├── decision-record.md
│   │   │   │   └── screen.cjs
│   │   │   ├── integration-dispositions/
│   │   │   │   ├── README.md
│   │   │   │   ├── counter-review.md
│   │   │   │   ├── decision-record.md
│   │   │   │   ├── dispositions.jsonl
│   │   │   │   └── dispositions.md
│   │   │   ├── language-boundaries/
│   │   │   │   ├── README.md
│   │   │   │   ├── decision-record.md
│   │   │   │   ├── file-coverage.tsv
│   │   │   │   └── inspect_artifacts.py
│   │   │   ├── library-fit/
│   │   │   │   ├── README.md
│   │   │   │   ├── assessments.jsonl
│   │   │   │   ├── assessments.md
│   │   │   │   ├── decision-record.md
│   │   │   │   ├── finding-crosswalk.tsv
│   │   │   │   └── review.md
│   │   │   ├── maintenance-benefit/
│   │   │   │   ├── README.md
│   │   │   │   ├── assessments.jsonl
│   │   │   │   ├── assessments.md
│   │   │   │   └── counter-review.md
│   │   │   ├── production-baseline/
│   │   │   │   ├── README.md
│   │   │   │   ├── measure.py
│   │   │   │   ├── mechanisms.jsonl
│   │   │   │   └── ts-inventory.cjs
│   │   │   ├── repair-queue/
│   │   │   │   ├── README.md
│   │   │   │   ├── decision-record.md
│   │   │   │   ├── independent-review.md
│   │   │   │   └── packets.md
│   │   │   ├── required-behavior/
│   │   │   │   ├── README.md
│   │   │   │   ├── authority-index.tsv
│   │   │   │   ├── contracts.jsonl
│   │   │   │   ├── contracts.md
│   │   │   │   ├── decision-record.md
│   │   │   │   ├── migration-requirements.md
│   │   │   │   ├── responsibility-contracts.tsv
│   │   │   │   ├── security-citations.tsv
│   │   │   │   └── security-review.md
│   │   │   ├── responsibility-callers/
│   │   │   │   ├── README.md
│   │   │   │   ├── dynamic-imports.tsv
│   │   │   │   ├── file-coverage.tsv
│   │   │   │   ├── index-callers.cjs
│   │   │   │   ├── public-apis.tsv
│   │   │   │   └── responsibilities.jsonl
│   │   │   ├── reviews/
│   │   │   │   ├── adapters.md
│   │   │   │   ├── adoption-sequence-review.md
│   │   │   │   ├── delivery-sequence-input.md
│   │   │   │   ├── economical-plan-check.md
│   │   │   │   ├── identity-state-challenge.md
│   │   │   │   ├── identity-state-work.md
│   │   │   │   ├── model-task-fit-review.md
│   │   │   │   ├── native-delivery.md
│   │   │   │   ├── start-sequence-check.md
│   │   │   │   ├── values-adapter-sequence-input.md
│   │   │   │   └── values.md
│   │   │   ├── security-limits/
│   │   │   │   ├── README.md
│   │   │   │   ├── duty-coverage.tsv
│   │   │   │   ├── enforcement.jsonl
│   │   │   │   ├── file-coverage.tsv
│   │   │   │   ├── findings.jsonl
│   │   │   │   ├── fix-queue.json
│   │   │   │   └── proposed-decisions.md
│   │   │   ├── tests-evidence/
│   │   │   │   ├── README.md
│   │   │   │   ├── claim-index.md
│   │   │   │   ├── claims.jsonl
│   │   │   │   ├── cleanup.md
│   │   │   │   └── counter-review.md
│   │   │   ├── README.md
│   │   │   ├── adoption-sequence.md
│   │   │   └── findings.json
│   │   └── package-subsystem-ports-20261006/
│   │       ├── evidence/
│   │       │   ├── full-evaluation/
│   │       │   │   ├── values-boundary-probe.mjs
│   │       │   │   └── work-artifact-probe.mjs
│   │       │   ├── implementation/
│   │       │   │   ├── artifact-preparation/
│   │       │   │   │   └── stage-contract.json
│   │       │   │   ├── exact-values/
│   │       │   │   │   └── core/
│   │       │   │   │       └── contracts.md
│   │       │   │   ├── shared/
│   │       │   │   │   ├── prepared-baseline-contract.json
│   │       │   │   │   └── transport-contracts.json
│   │       │   │   └── work-transitions/
│   │       │   │       ├── baselines/
│   │       │   │       │   └── original-fixtures/
│   │       │   │       │       ├── clone-vectors.json
│   │       │   │       │       └── identity-vectors.json
│   │       │   │       ├── contracts/
│   │       │   │       │   ├── coverage.md
│   │       │   │       │   └── profiles.md
│   │       │   │       ├── handoffs/
│   │       │   │       │   ├── abi.md
│   │       │   │       │   └── build-request.md
│   │       │   │       └── ownership/
│   │       │   │           └── graph.md
│   │       │   ├── input-validation/
│   │       │   │   ├── abi-decisions.md
│   │       │   │   ├── abi-vectors.json
│   │       │   │   ├── contracts.md
│   │       │   │   ├── http-adoption-gate.md
│   │       │   │   ├── plan-contract.md
│   │       │   │   ├── prepared-hook-review.md
│   │       │   │   ├── prepared-plan-handoff.md
│   │       │   │   ├── state-contract.md
│   │       │   │   └── v01-review.md
│   │       │   ├── lane-conversion/
│   │       │   │   └── README.md
│   │       │   └── arithmetic-probe.mjs
│   │       ├── implementation-plans/
│   │       │   ├── README.md
│   │       │   ├── artifact-preparation.md
│   │       │   ├── exact-values.md
│   │       │   ├── input-validation.audit.md
│   │       │   ├── input-validation.md
│   │       │   └── work-transitions.md
│   │       ├── README.md
│   │       ├── boundary-options.md
│   │       └── full-evaluation.md
│   ├── specification/
│   │   ├── BUILD_GENERATION_REQUIREMENTS.md
│   │   ├── CONSTRUCT-HELP.md
│   │   ├── DECISIONS.md
│   │   ├── DESIGN.md
│   │   ├── GRAMMAR.md
│   │   └── REQUIREMENTS.md
│   ├── authoring-demo.md
│   ├── dev-setup.md
│   ├── draft-frontend-validation.md
│   ├── e2e.md
│   ├── handbook-coverage-audit.md
│   ├── ideal-filetree-plan.md
│   ├── install.md
│   ├── soda-runtime.md
│   └── zero-diag-big-three.md
├── draft/
│   ├── apps/
│   │   ├── CanAffiliate/
│   │   │   ├── .legacy.saved/
│   │   │   │   └── fa30709d-9fba-4496-955c-b1547917cde4/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── can.generated/
│   │   │   │   └── fa30709d-9fba-4496-955c-b1547917cde4/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-main-desktop.png
│   │   │   │   │   ├── 01-main-desktop.prompt.md
│   │   │   │   │   ├── 01-partners-desktop-left-correction.prompt.md
│   │   │   │   │   ├── 01-partners-desktop-left.png
│   │   │   │   │   ├── 01-partners-desktop-left.prompt.md
│   │   │   │   │   ├── 02-own-commissions-desktop-left.png
│   │   │   │   │   ├── 02-own-commissions-desktop-left.prompt.md
│   │   │   │   │   ├── 02-own-commissions-desktop.prompt.md
│   │   │   │   │   ├── 03-introduction-desktop-left-correction.prompt.md
│   │   │   │   │   ├── 03-introduction-desktop-left.png
│   │   │   │   │   ├── 03-introduction-desktop-left.prompt.md
│   │   │   │   │   ├── 03-introduction-mobile.prompt.md
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanAffiliate.can
│   │   │   ├── CanAffiliate.md
│   │   │   └── playwright.config.ts
│   │   ├── CanApprove/
│   │   │   ├── can.generated/
│   │   │   │   ├── 94b752a0-8663-4725-9a72-53874e5be1cb/
│   │   │   │   │   ├── server.js
│   │   │   │   │   ├── source-behavior.can.txt
│   │   │   │   │   └── unit.json
│   │   │   │   ├── c75c9eb5-3a9a-48f3-9fc9-b146ca2d83f2/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   └── cbc5aab0-946c-4fe5-b500-8666af26aa2f/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-review-decision-desktop-left.png
│   │   │   │   │   ├── 01-review-decision-desktop-left.prompt.md
│   │   │   │   │   ├── 01-review-decision-desktop.prompt.md
│   │   │   │   │   ├── 02-own-versions-desktop-left-correction.prompt.md
│   │   │   │   │   ├── 02-own-versions-desktop-left.png
│   │   │   │   │   ├── 02-own-versions-desktop-left.prompt.md
│   │   │   │   │   ├── 02-own-versions-desktop.prompt.md
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanApprove.can
│   │   │   ├── CanApprove.md
│   │   │   ├── CanApprove.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanBoard/
│   │   │   ├── can.generated/
│   │   │   │   ├── 1337f3b5-3901-42ce-9c04-dc2e263f8c62/
│   │   │   │   │   ├── contributions.can
│   │   │   │   │   ├── source-behavior.can.txt
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 5ab8f3ca-b4d6-48c2-a74d-ffea2ce437ec/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 69e7ab05-ce58-450d-a864-f8af3e03f5ed/
│   │   │   │   │   ├── server.js
│   │   │   │   │   ├── source-behavior.can.txt
│   │   │   │   │   └── unit.json
│   │   │   │   ├── ad2c4ef5-40e0-44f3-83ec-ef4b49dc7179/
│   │   │   │   │   ├── contributions.can
│   │   │   │   │   ├── source-behavior.can.txt
│   │   │   │   │   └── unit.json
│   │   │   │   └── e55dbd9a-2643-4ec0-9fc4-f4588f1dac16/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-final-record-desktop-left.png
│   │   │   │   │   ├── 01-final-record-desktop-left.prompt.md
│   │   │   │   │   ├── 01-final-record-desktop-v2.prompt.md
│   │   │   │   │   ├── 01-final-record-desktop.prompt.md
│   │   │   │   │   ├── 02-assigned-action-mobile.prompt.md
│   │   │   │   │   ├── 02-assigned-actions-desktop-left-correction.prompt.md
│   │   │   │   │   ├── 02-assigned-actions-desktop-left.png
│   │   │   │   │   ├── 02-assigned-actions-desktop-left.prompt.md
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanBoard.can
│   │   │   ├── CanBoard.md
│   │   │   ├── CanBoard.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanBook/
│   │   │   ├── .legacy.saved/
│   │   │   │   └── 042ee9f6-4e79-41ea-844e-cbb357e6a43a/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── can.generated/
│   │   │   │   └── 042ee9f6-4e79-41ea-844e-cbb357e6a43a/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-appointments-desktop-left.png
│   │   │   │   │   ├── 01-appointments-desktop-left.prompt.md
│   │   │   │   │   ├── 01-appointments-desktop-v2.prompt.md
│   │   │   │   │   ├── 01-appointments-desktop.prompt.md
│   │   │   │   │   ├── 02-host-agenda-desktop-left.png
│   │   │   │   │   ├── 02-host-agenda-desktop-left.prompt.md
│   │   │   │   │   ├── 02-host-agenda-desktop-v2.prompt.md
│   │   │   │   │   ├── 02-host-agenda-desktop.prompt.md
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanBook.can
│   │   │   ├── CanBook.md
│   │   │   └── playwright.config.ts
│   │   ├── CanCRM/
│   │   │   ├── .legacy.saved/
│   │   │   │   ├── 17a4aadd-c628-4ee6-9385-7b3385353862/
│   │   │   │   │   ├── contributions.can
│   │   │   │   │   ├── server.js
│   │   │   │   │   ├── source-behavior.can.txt
│   │   │   │   │   └── unit.json
│   │   │   │   └── f36929d0-9979-4e50-ba63-357663dbd5d0/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── can.generated/
│   │   │   │   ├── 17a4aadd-c628-4ee6-9385-7b3385353862/
│   │   │   │   │   ├── contributions.can
│   │   │   │   │   ├── server.js
│   │   │   │   │   ├── source-behavior.can.txt
│   │   │   │   │   └── unit.json
│   │   │   │   └── f36929d0-9979-4e50-ba63-357663dbd5d0/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-sales-board-desktop-left-correction.prompt.md
│   │   │   │   │   ├── 01-sales-board-desktop-left.png
│   │   │   │   │   ├── 01-sales-board-desktop-left.prompt.md
│   │   │   │   │   ├── 01-sales-board-desktop-v2.prompt.md
│   │   │   │   │   ├── 01-sales-board-desktop.prompt.md
│   │   │   │   │   ├── 02-sale-evidence-desktop-left.png
│   │   │   │   │   ├── 02-sale-evidence-desktop-left.prompt.md
│   │   │   │   │   ├── 02-sale-evidence-desktop.prompt.md
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanCRM.can
│   │   │   ├── CanCRM.md
│   │   │   ├── CanCRM.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanCatch/
│   │   │   ├── can.generated/
│   │   │   │   └── 15437397-d74e-408e-aa3d-c50e7e4460b8/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-error-triage-desktop-left-correction.prompt.md
│   │   │   │   │   ├── 01-error-triage-desktop-left.png
│   │   │   │   │   ├── 01-error-triage-desktop-left.prompt.md
│   │   │   │   │   ├── 01-error-triage-desktop.prompt.md
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanCatch.can
│   │   │   ├── CanCatch.md
│   │   │   └── playwright.config.ts
│   │   ├── CanChat/
│   │   │   ├── can.generated/
│   │   │   │   └── cbc2e655-230f-4a3c-b71b-31fce27a9e58/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-conversation-desktop-left.png
│   │   │   │   │   ├── 01-conversation-desktop-left.prompt.md
│   │   │   │   │   ├── 01-conversation-desktop-v2.prompt.md
│   │   │   │   │   ├── 01-conversation-desktop.prompt.md
│   │   │   │   │   ├── 02-access-limits-desktop-left.png
│   │   │   │   │   ├── 02-access-limits-desktop-left.prompt.md
│   │   │   │   │   ├── 02-access-limits-desktop.prompt.md
│   │   │   │   │   ├── 03-recovery-desktop-left.png
│   │   │   │   │   ├── 03-recovery-desktop-left.prompt.md
│   │   │   │   │   ├── 03-recovery-desktop.prompt.md
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanChat.can
│   │   │   ├── CanChat.md
│   │   │   ├── CanChat.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanCheck/
│   │   │   ├── can.generated/
│   │   │   │   └── 6ad3467e-ead7-466f-b3bb-ec339e2971e3/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-job-health-desktop-left.png
│   │   │   │   │   ├── 01-job-health-desktop-left.prompt.md
│   │   │   │   │   ├── 01-job-health-desktop-v2.prompt.md
│   │   │   │   │   ├── 01-job-health-desktop.prompt.md
│   │   │   │   │   ├── 02-never-pinged-mobile.prompt.md
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanCheck.can
│   │   │   ├── CanCheck.md
│   │   │   ├── CanCheck.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanContract/
│   │   │   ├── .legacy.saved/
│   │   │   │   └── 8fdb3119-6264-467d-9b01-09e7b260af1a/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── can.generated/
│   │   │   │   └── 8fdb3119-6264-467d-9b01-09e7b260af1a/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-renewal-desktop-left-correction.prompt.md
│   │   │   │   │   ├── 01-renewal-desktop-left.png
│   │   │   │   │   ├── 01-renewal-desktop-left.prompt.md
│   │   │   │   │   ├── 01-renewal-desktop-v2.prompt.md
│   │   │   │   │   ├── 01-renewal-desktop.prompt.md
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanContract.can
│   │   │   ├── CanContract.md
│   │   │   └── playwright.config.ts
│   │   ├── CanCreative/
│   │   │   ├── can.generated/
│   │   │   │   └── c801badd-aac0-466a-abd9-e1feb4885dc7/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-image-studio-desktop-left.png
│   │   │   │   │   ├── 01-image-studio-desktop-left.prompt.md
│   │   │   │   │   ├── 01-image-studio-desktop-v2.prompt.md
│   │   │   │   │   ├── 01-image-studio-desktop.prompt.md
│   │   │   │   │   ├── 02-workflow-templates-desktop-left-correction.prompt.md
│   │   │   │   │   ├── 02-workflow-templates-desktop-left.png
│   │   │   │   │   ├── 02-workflow-templates-desktop-left.prompt.md
│   │   │   │   │   ├── 02-workflow-templates-desktop.prompt.md
│   │   │   │   │   ├── 03-recovery-desktop-left-correction.prompt.md
│   │   │   │   │   ├── 03-recovery-desktop-left.png
│   │   │   │   │   ├── 03-recovery-desktop-left.prompt.md
│   │   │   │   │   ├── 03-recovery-desktop.prompt.md
│   │   │   │   │   ├── 04-chat-to-image-desktop-left.png
│   │   │   │   │   ├── 04-chat-to-image-desktop-left.prompt.md
│   │   │   │   │   ├── 04-chat-to-image-desktop.prompt.md
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanCreative.can
│   │   │   ├── CanCreative.md
│   │   │   ├── CanCreative.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanCustomer/
│   │   │   ├── .legacy.saved/
│   │   │   │   └── 6564ce69-85c8-473e-a29f-10e6c3c83acd/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── can.generated/
│   │   │   │   └── 6564ce69-85c8-473e-a29f-10e6c3c83acd/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-company-people-desktop-left.png
│   │   │   │   │   ├── 01-company-people-desktop-left.prompt.md
│   │   │   │   │   ├── 01-company-people-desktop-v2.prompt.md
│   │   │   │   │   ├── 01-company-people-desktop.prompt.md
│   │   │   │   │   ├── 02-invitation-mobile.prompt.md
│   │   │   │   │   ├── 02-invitations-desktop-left.png
│   │   │   │   │   ├── 02-invitations-desktop-left.prompt.md
│   │   │   │   │   ├── 03-directory-desktop-left-correction-2.prompt.md
│   │   │   │   │   ├── 03-directory-desktop-left-correction.prompt.md
│   │   │   │   │   ├── 03-directory-desktop-left.png
│   │   │   │   │   ├── 03-directory-desktop-left.prompt.md
│   │   │   │   │   ├── 03-directory-desktop.prompt.md
│   │   │   │   │   ├── 04-billing-approval-desktop-left.png
│   │   │   │   │   ├── 04-billing-approval-desktop-left.prompt.md
│   │   │   │   │   ├── 04-billing-approval-desktop.prompt.md
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanCustomer.can
│   │   │   ├── CanCustomer.md
│   │   │   └── playwright.config.ts
│   │   ├── CanDecide/
│   │   │   ├── can.generated/
│   │   │   │   └── 9abe5d15-42a5-404a-ab4c-3b207529c2dd/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-advisory-decision-desktop-left.png
│   │   │   │   │   ├── 01-advisory-decision-desktop-left.prompt.md
│   │   │   │   │   ├── 01-advisory-decision-desktop-v2.prompt.md
│   │   │   │   │   ├── 01-advisory-decision-desktop.prompt.md
│   │   │   │   │   ├── 02-independent-review-desktop-left.png
│   │   │   │   │   ├── 02-independent-review-desktop-left.prompt.md
│   │   │   │   │   ├── 02-independent-review-desktop.prompt.md
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanDecide.can
│   │   │   ├── CanDecide.md
│   │   │   ├── CanDecide.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanDesk/
│   │   │   ├── can.generated/
│   │   │   │   └── d8aca0b3-2bad-4ad4-9119-f8dbdfb08c41/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-support-desktop-left.png
│   │   │   │   │   ├── 01-support-desktop-left.prompt.md
│   │   │   │   │   ├── 01-support-desktop-v2.prompt.md
│   │   │   │   │   ├── 01-support-desktop.prompt.md
│   │   │   │   │   ├── 02-own-support-desktop-left-correction.prompt.md
│   │   │   │   │   ├── 02-own-support-desktop-left.png
│   │   │   │   │   ├── 02-own-support-desktop-left.prompt.md
│   │   │   │   │   ├── 02-own-support-mobile.prompt.md
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanDesk.can
│   │   │   ├── CanDesk.md
│   │   │   └── playwright.config.ts
│   │   ├── CanDiscover/
│   │   │   ├── can.generated/
│   │   │   │   └── e3220085-a11e-45ba-a115-67afec683f39/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-evidence-review-desktop.png
│   │   │   │   │   ├── 02-plans-coverage-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanDiscover.can
│   │   │   ├── CanDiscover.md
│   │   │   ├── CanDiscover.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanDo/
│   │   │   ├── can.generated/
│   │   │   │   ├── 6fcf67fa-3142-456b-820e-4bb6984c4f9a/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 83d38174-0aeb-4375-b22f-1cb5d592865d/
│   │   │   │   │   ├── server.js
│   │   │   │   │   ├── source-behavior.can.txt
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 95adf04d-f675-4e6b-be57-0a865fe8b6c0/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── d9217c55-4f61-42b3-a1fd-a6595e9d04ad/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── daecce9f-091e-4943-b0ca-96d0490dcf73/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── e60d6725-ade8-4b08-85ab-fb77b6c12d6e/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   └── f42fc727-363b-4699-8ace-ccc174889e6f/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-tasks-desktop.png
│   │   │   │   │   ├── 02-my-work-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanDo.can
│   │   │   ├── CanDo.md
│   │   │   ├── CanDo.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanEnrich/
│   │   │   ├── can.generated/
│   │   │   │   └── 21e4c10d-b963-4626-acef-656ffb5af4d1/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-company-review-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanEnrich.can
│   │   │   ├── CanEnrich.md
│   │   │   ├── CanEnrich.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanEvent/
│   │   │   ├── can.generated/
│   │   │   │   └── 4ff9b942-4f3f-4eef-9a10-d510c33d6885/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-event-registration-desktop.png
│   │   │   │   │   ├── 02-event-operations-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanEvent.can
│   │   │   ├── CanEvent.md
│   │   │   └── playwright.config.ts
│   │   ├── CanExpense/
│   │   │   ├── .legacy.saved/
│   │   │   │   ├── 2bf4b6bc-1c8a-4e5e-806d-562c18f0d766/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 4f42c71c-385e-4267-8a31-a72e47a03cee/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   └── cd4fec34-15a8-410c-aa5f-fe27ae92ca82/
│   │   │   │       ├── server.js
│   │   │   │       ├── source-behavior.can.txt
│   │   │   │       └── unit.json
│   │   │   ├── can.generated/
│   │   │   │   ├── 2bf4b6bc-1c8a-4e5e-806d-562c18f0d766/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 4f42c71c-385e-4267-8a31-a72e47a03cee/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   └── cd4fec34-15a8-410c-aa5f-fe27ae92ca82/
│   │   │   │       ├── implementation.js
│   │   │   │       ├── server.js
│   │   │   │       ├── source-behavior.can.txt
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-private-claim-desktop.png
│   │   │   │   │   ├── 02-review-reimbursement-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanExpense.can
│   │   │   ├── CanExpense.md
│   │   │   ├── CanExpense.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanFeedback/
│   │   │   ├── can.generated/
│   │   │   │   ├── 924350ef-8c5e-4d55-b5a0-185b3e256e7b/
│   │   │   │   │   ├── contributions.can
│   │   │   │   │   ├── server.js
│   │   │   │   │   ├── source-behavior.can.txt
│   │   │   │   │   └── unit.json
│   │   │   │   └── 9687f98b-c18b-4d19-bfbb-efcaf6b60202/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-suggestions-desktop.png
│   │   │   │   │   ├── 02-moderation-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanFeedback.can
│   │   │   ├── CanFeedback.md
│   │   │   ├── CanFeedback.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanField/
│   │   │   ├── can.generated/
│   │   │   │   └── c6fa6eab-e0c8-4fc8-a233-c3f8d35dec2d/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-dispatch-desktop.png
│   │   │   │   │   ├── 02-my-visit-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanField.can
│   │   │   ├── CanField.md
│   │   │   └── playwright.config.ts
│   │   ├── CanGallery/
│   │   │   ├── can.generated/
│   │   │   │   ├── 9f938d74-1a35-46af-a338-a06bfde822a8/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── c4d1e075-614f-4c23-b902-ee90a44e922d/
│   │   │   │   │   ├── server.js
│   │   │   │   │   ├── source-behavior.can.txt
│   │   │   │   │   └── unit.json
│   │   │   │   └── eab85950-8b2f-4dbe-904b-de07f3e90b38/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-approved-collection-desktop.png
│   │   │   │   │   ├── 02-image-review-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanGallery.can
│   │   │   ├── CanGallery.md
│   │   │   ├── CanGallery.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanGrant/
│   │   │   ├── can.generated/
│   │   │   │   └── 9b70941d-bec1-4b21-ad44-e0988deb0152/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-award-review-desktop.png
│   │   │   │   │   ├── 02-applicant-intake-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanGrant.can
│   │   │   ├── CanGrant.md
│   │   │   ├── CanGrant.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanHire/
│   │   │   ├── can.generated/
│   │   │   │   ├── 3bdad14f-246f-48a3-a712-de60ca3f8ba9/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 7f82162a-7657-41af-94e3-e8bb516ff940/
│   │   │   │   │   ├── server.js
│   │   │   │   │   ├── source-behavior.can.txt
│   │   │   │   │   └── unit.json
│   │   │   │   └── 8035fbf7-76b4-4f04-9ee2-30682279c25f/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-hiring-desktop.png
│   │   │   │   │   ├── 02-careers-application-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanHire.can
│   │   │   ├── CanHire.md
│   │   │   ├── CanHire.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanInbox/
│   │   │   ├── can.generated/
│   │   │   │   └── 38541993-5b38-4c7f-8068-7c3362ffc68a/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-departmental-inbox-desktop.png
│   │   │   │   │   ├── 02-uncertain-reply-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanInbox.can
│   │   │   ├── CanInbox.md
│   │   │   ├── CanInbox.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanInvoice/
│   │   │   ├── .legacy.saved/
│   │   │   │   ├── 67dc95cb-2e5d-4cba-a75a-84016fb2d8e4/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 82abfa39-a517-48a7-accf-075679dccdd8/
│   │   │   │   │   ├── server.js
│   │   │   │   │   ├── source-behavior.can.txt
│   │   │   │   │   └── unit.json
│   │   │   │   └── ad1ff6d9-98b8-471e-a72d-5f7739ae82af/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── can.generated/
│   │   │   │   ├── 67dc95cb-2e5d-4cba-a75a-84016fb2d8e4/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 82abfa39-a517-48a7-accf-075679dccdd8/
│   │   │   │   │   ├── implementation.js
│   │   │   │   │   ├── server.js
│   │   │   │   │   ├── source-behavior.can.txt
│   │   │   │   │   └── unit.json
│   │   │   │   └── ad1ff6d9-98b8-471e-a72d-5f7739ae82af/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-own-invoice-desktop.png
│   │   │   │   │   ├── 02-issued-document-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanInvoice.can
│   │   │   ├── CanInvoice.md
│   │   │   ├── CanInvoice.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanKnowledge/
│   │   │   ├── can.generated/
│   │   │   │   └── 325f4643-e574-4fc3-837a-b35aa33f5eab/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-private-sourced-answer-desktop.png
│   │   │   │   │   ├── 02-procedure-editor-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanKnowledge.can
│   │   │   ├── CanKnowledge.md
│   │   │   ├── CanKnowledge.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanLearn/
│   │   │   ├── can.generated/
│   │   │   │   └── ee3f57d2-6e19-4ec7-89e1-9b9ff75746b6/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 02-my-learning-desktop.png
│   │   │   │   │   ├── 03-learning-courses-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanLearn.can
│   │   │   ├── CanLearn.md
│   │   │   ├── CanLearn.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanLeave/
│   │   │   ├── can.generated/
│   │   │   │   └── 807b491b-fa5c-4628-adfe-5e2632ad563e/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 02-leave-mine-desktop.png
│   │   │   │   │   ├── 03-leave-review-desktop.png
│   │   │   │   │   ├── 04-leave-absence-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanLeave.can
│   │   │   ├── CanLeave.md
│   │   │   ├── CanLeave.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanLoyalty/
│   │   │   ├── can.generated/
│   │   │   │   └── 6786244e-1dc9-42dc-8dac-85631e0c64d3/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 02-loyalty-desktop.png
│   │   │   │   │   ├── 03-loyalty-fulfillment-desktop.png
│   │   │   │   │   ├── 04-loyalty-catalog-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanLoyalty.can
│   │   │   ├── CanLoyalty.md
│   │   │   ├── CanLoyalty.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanMail/
│   │   │   ├── can.generated/
│   │   │   │   └── bedf34aa-261f-4391-a39b-3e6b300cfdd9/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 02-mailroom-desktop.png
│   │   │   │   │   ├── 03-mailroom-mine-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanMail.can
│   │   │   ├── CanMail.md
│   │   │   ├── CanMail.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanMaintain/
│   │   │   ├── can.generated/
│   │   │   │   └── 313b9d10-4130-4c0b-9411-a0097603f576/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 02-facilities-desktop.png
│   │   │   │   │   ├── 03-facilities-my-reports-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanMaintain.can
│   │   │   ├── CanMaintain.md
│   │   │   ├── CanMaintain.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanMember/
│   │   │   ├── .legacy.saved/
│   │   │   │   ├── 4061ac1e-8d2f-496c-b91e-3b986bae9201/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 62d80d28-5ac3-4492-a807-fddc0d9b4243/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 89d88c00-3a9f-4e2c-8c23-48f0b38304f8/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── b4cc98e1-cb0f-496a-867c-35516800681f/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   └── e316d491-404c-4c3d-a890-76b896ed5b81/
│   │   │   │       ├── server.js
│   │   │   │       ├── source-behavior.can.txt
│   │   │   │       └── unit.json
│   │   │   ├── can.generated/
│   │   │   │   ├── 4061ac1e-8d2f-496c-b91e-3b986bae9201/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 62d80d28-5ac3-4492-a807-fddc0d9b4243/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 89d88c00-3a9f-4e2c-8c23-48f0b38304f8/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── b4cc98e1-cb0f-496a-867c-35516800681f/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   └── e316d491-404c-4c3d-a890-76b896ed5b81/
│   │   │   │       ├── implementation.js
│   │   │   │       ├── server.js
│   │   │   │       ├── source-behavior.can.txt
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 02-membership-plans-desktop.png
│   │   │   │   │   ├── 03-membership-access-review-desktop.png
│   │   │   │   │   ├── 05-membership-mine-desktop.png
│   │   │   │   │   ├── 06-membership-register-desktop.png
│   │   │   │   │   ├── 08-membership-content-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanMember.can
│   │   │   ├── CanMember.md
│   │   │   ├── CanMember.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanOnboard/
│   │   │   ├── can.generated/
│   │   │   │   └── 1dcedacc-0769-4629-9c07-03b9814c94a9/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-main-desktop.prompt.md
│   │   │   │   │   ├── 02-people-my-readiness-desktop.png
│   │   │   │   │   ├── 03-people-onboarding-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanOnboard.can
│   │   │   ├── CanOnboard.md
│   │   │   ├── CanOnboard.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanPromptLab/
│   │   │   ├── can.generated/
│   │   │   │   ├── 00b3ab48-debe-4e95-8145-e8a4f004a359/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 19a9e8eb-2e04-411b-9ad4-3c546f346c6b/
│   │   │   │   │   ├── implementation.js
│   │   │   │   │   ├── server.js
│   │   │   │   │   ├── source-behavior.can.txt
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 1ecb0b4d-6e0f-4c4f-8948-9ca1708838d5/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 2176e06f-ce36-471c-b615-46964907e8e2/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 299b892b-b88d-48ac-b180-b7263988b26c/
│   │   │   │   │   ├── implementation.js
│   │   │   │   │   ├── server.js
│   │   │   │   │   ├── source-behavior.can.txt
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 2c01f326-d9de-4799-9fd2-df9acaa13192/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 514c292f-e6f5-4ea4-ab59-393ca07c0ef1/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 8a094704-26cd-4595-a3ac-6aec9050c339/
│   │   │   │   │   ├── contributions.can
│   │   │   │   │   ├── source-behavior.can.txt
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 8c6f723b-446e-4523-bfd3-5e98b6086d08/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 968b443f-b0b0-4e52-b82b-4e9cdb7d1608/
│   │   │   │   │   ├── contributions.can
│   │   │   │   │   ├── implementation.js
│   │   │   │   │   ├── server.js
│   │   │   │   │   ├── source-behavior.can.txt
│   │   │   │   │   └── unit.json
│   │   │   │   ├── be951c09-0eb9-43b0-af6b-ba79746e1627/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── bfcf7560-a72e-413f-af2a-a0d05669a38c/
│   │   │   │   │   ├── implementation.js
│   │   │   │   │   ├── server.js
│   │   │   │   │   ├── source-behavior.can.txt
│   │   │   │   │   └── unit.json
│   │   │   │   ├── ce6cb0e3-40bb-43e1-a5af-b4577d5fb73c/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── d9777a9b-960d-4d97-a300-ef038c9b5682/
│   │   │   │   │   ├── contributions.can
│   │   │   │   │   ├── source-behavior.can.txt
│   │   │   │   │   └── unit.json
│   │   │   │   ├── e68621ed-c8cc-4659-9372-f4fe65e6fe6f/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── f42e149e-3567-4a38-a5e7-b0383be0712c/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   └── fe6c6573-2cb3-431f-b51a-7e06f9f3953b/
│   │   │   │       ├── contributions.can
│   │   │   │       ├── implementation.js
│   │   │   │       ├── server.js
│   │   │   │       ├── source-behavior.can.txt
│   │   │   │       └── unit.json
│   │   │   ├── legacy.saved/
│   │   │   │   ├── 5b42ee83-af9b-4751-b6ef-13790e5598a1/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 7c5a7773-59f1-4106-8fb9-9795ed0bca34/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── c301abcd-de6b-4c1c-a796-ead5f89d0102/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   └── README.md
│   │   │   ├── playwright/
│   │   │   │   ├── baselines/
│   │   │   │   │   ├── desktop/
│   │   │   │   │   │   └── CanPromptLab/
│   │   │   │   │   │       ├── catalogs-archived-denied-desktop.png
│   │   │   │   │   │       ├── catalogs-archived-empty-desktop.png
│   │   │   │   │   │       ├── catalogs-archived-initial-desktop.png
│   │   │   │   │   │       ├── catalogs-archived-populated-desktop.png
│   │   │   │   │   │       ├── catalogs-denied-desktop.png
│   │   │   │   │   │       ├── catalogs-dialog-open-desktop.png
│   │   │   │   │   │       ├── catalogs-empty-desktop.png
│   │   │   │   │   │       ├── catalogs-expanded-desktop.png
│   │   │   │   │   │       ├── catalogs-initial-desktop.png
│   │   │   │   │   │       ├── catalogs-menu-open-desktop.png
│   │   │   │   │   │       ├── catalogs-populated-desktop.png
│   │   │   │   │   │       ├── catalogs-validation-desktop.png
│   │   │   │   │   │       ├── tags-denied-desktop.png
│   │   │   │   │   │       ├── tags-empty-desktop.png
│   │   │   │   │   │       ├── tags-expanded-desktop.png
│   │   │   │   │   │       ├── tags-failure-desktop.png
│   │   │   │   │   │       ├── tags-initial-desktop.png
│   │   │   │   │   │       ├── tags-populated-desktop.png
│   │   │   │   │   │       └── tags-validation-desktop.png
│   │   │   │   │   └── mobile/
│   │   │   │   │       └── CanPromptLab/
│   │   │   │   │           ├── catalogs-archived-denied-mobile.png
│   │   │   │   │           ├── catalogs-archived-empty-mobile.png
│   │   │   │   │           ├── catalogs-archived-initial-mobile.png
│   │   │   │   │           ├── catalogs-archived-populated-mobile.png
│   │   │   │   │           ├── catalogs-denied-mobile.png
│   │   │   │   │           ├── catalogs-dialog-open-mobile.png
│   │   │   │   │           ├── catalogs-empty-mobile.png
│   │   │   │   │           ├── catalogs-expanded-mobile.png
│   │   │   │   │           ├── catalogs-initial-mobile.png
│   │   │   │   │           ├── catalogs-menu-open-mobile.png
│   │   │   │   │           ├── catalogs-populated-mobile.png
│   │   │   │   │           ├── catalogs-validation-mobile.png
│   │   │   │   │           ├── tags-denied-mobile.png
│   │   │   │   │           ├── tags-empty-mobile.png
│   │   │   │   │           ├── tags-expanded-mobile.png
│   │   │   │   │           ├── tags-failure-mobile.png
│   │   │   │   │           ├── tags-initial-mobile.png
│   │   │   │   │           ├── tags-populated-mobile.png
│   │   │   │   │           └── tags-validation-mobile.png
│   │   │   │   ├── references/
│   │   │   │   │   ├── 02-catalogs-desktop.png
│   │   │   │   │   ├── 03-tags-desktop.png
│   │   │   │   │   ├── 04-catalogs-archived-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanPromptLab.can
│   │   │   ├── CanPromptLab.md
│   │   │   └── playwright.config.ts
│   │   ├── CanPropose/
│   │   │   ├── .legacy.saved/
│   │   │   │   └── 7b137fca-2ed2-4092-927e-c46d36f5e099/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── can.generated/
│   │   │   │   └── 7b137fca-2ed2-4092-927e-c46d36f5e099/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-main-desktop.prompt.md
│   │   │   │   │   ├── 02-offers-desktop.png
│   │   │   │   │   ├── 03-offers-respond-Revision.id-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanPropose.can
│   │   │   ├── CanPropose.md
│   │   │   ├── CanPropose.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanPurchase/
│   │   │   ├── can.generated/
│   │   │   │   └── 438afa50-1dc3-4dbe-ac89-4d4ad0440e36/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-main-desktop.prompt.md
│   │   │   │   │   ├── 02-purchasing-mine-desktop.png
│   │   │   │   │   ├── 03-purchasing-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanPurchase.can
│   │   │   ├── CanPurchase.md
│   │   │   ├── CanPurchase.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanReception/
│   │   │   ├── can.generated/
│   │   │   │   └── 8ae3538f-80d7-4913-8eb5-9c86f45a536e/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-main-desktop.prompt.md
│   │   │   │   │   ├── 04-reception-desktop.png
│   │   │   │   │   ├── 05-reception-credentials-desktop.png
│   │   │   │   │   ├── 06-reception-mine-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanReception.can
│   │   │   ├── CanReception.md
│   │   │   ├── CanReception.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanRefer/
│   │   │   ├── .legacy.saved/
│   │   │   │   └── 70dfcdbb-9e00-4984-b68d-7735e3d921e6/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── can.generated/
│   │   │   │   └── 70dfcdbb-9e00-4984-b68d-7735e3d921e6/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-main-desktop.prompt.md
│   │   │   │   │   ├── 02-referrals-desktop.png
│   │   │   │   │   ├── 03-referrals-work-desktop.png
│   │   │   │   │   ├── 04-referrals-share-Advocate.id-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanRefer.can
│   │   │   ├── CanRefer.md
│   │   │   ├── CanRefer.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanRent/
│   │   │   ├── .legacy.saved/
│   │   │   │   ├── 249f810d-51aa-4f1b-873c-7c16349d5deb/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 2f7c5d8b-3c9e-4df5-8526-f0380480d146/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 5dfb6c46-e9a6-49d2-ba85-76dfc31264e3/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   └── a07f2643-7992-4670-ae3f-7425c4878630/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── can.generated/
│   │   │   │   ├── 249f810d-51aa-4f1b-873c-7c16349d5deb/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 2f7c5d8b-3c9e-4df5-8526-f0380480d146/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── 5dfb6c46-e9a6-49d2-ba85-76dfc31264e3/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   └── a07f2643-7992-4670-ae3f-7425c4878630/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-main-desktop.prompt.md
│   │   │   │   │   ├── 05-workspace-resources-desktop.png
│   │   │   │   │   ├── 06-workspace-desktop.png
│   │   │   │   │   ├── 07-workspace-reservations-desktop.png
│   │   │   │   │   ├── 08-workspace-my-bookings-desktop.png
│   │   │   │   │   ├── 10-workspace-occupancy-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanRent.can
│   │   │   ├── CanRent.md
│   │   │   ├── CanRent.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanReport/
│   │   │   ├── .legacy.saved/
│   │   │   │   └── c54dd3ee-699e-4ea0-a985-b177d5b5586d/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── can.generated/
│   │   │   │   └── c54dd3ee-699e-4ea0-a985-b177d5b5586d/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-main-desktop.prompt.md
│   │   │   │   │   ├── 01-utilization-populated-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanReport.can
│   │   │   ├── CanReport.md
│   │   │   ├── CanReport.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanShift/
│   │   │   ├── can.generated/
│   │   │   │   └── 671bf883-ef1b-4034-964a-7600ed3470fe/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-main-desktop.prompt.md
│   │   │   │   │   ├── 01-roster-populated-desktop.png
│   │   │   │   │   ├── 02-own-shifts-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanShift.can
│   │   │   ├── CanShift.md
│   │   │   ├── CanShift.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanStats/
│   │   │   ├── can.generated/
│   │   │   │   └── 7ab9c54c-bf49-42a3-ae64-7489864275e8/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-main-desktop.prompt.md
│   │   │   │   │   ├── 01-traffic-populated-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanStats.can
│   │   │   ├── CanStats.md
│   │   │   ├── CanStats.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanStock/
│   │   │   ├── .legacy.saved/
│   │   │   │   ├── 2b33cba9-6656-420d-9447-38db1a069cb9/
│   │   │   │   │   ├── contributions.can
│   │   │   │   │   ├── server.js
│   │   │   │   │   ├── source-behavior.can.txt
│   │   │   │   │   └── unit.json
│   │   │   │   └── 55a73869-0fc6-4f3a-9416-c5a1473a74c8/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── can.generated/
│   │   │   │   ├── 2b33cba9-6656-420d-9447-38db1a069cb9/
│   │   │   │   │   ├── contributions.can
│   │   │   │   │   ├── server.js
│   │   │   │   │   ├── source-behavior.can.txt
│   │   │   │   │   └── unit.json
│   │   │   │   └── 55a73869-0fc6-4f3a-9416-c5a1473a74c8/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-main-desktop.prompt.md
│   │   │   │   │   ├── 01-posting-queue-desktop.png
│   │   │   │   │   ├── 02-ledger-transfer-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanStock.can
│   │   │   ├── CanStock.md
│   │   │   ├── CanStock.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanSuccess/
│   │   │   ├── .legacy.saved/
│   │   │   │   └── efb5fb76-df38-445d-ad20-7d7a5635da69/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── can.generated/
│   │   │   │   └── efb5fb76-df38-445d-ad20-7d7a5635da69/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-main-desktop.prompt.md
│   │   │   │   │   ├── 01-renewal-portfolio-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanSuccess.can
│   │   │   ├── CanSuccess.md
│   │   │   ├── CanSuccess.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanSync/
│   │   │   ├── can.generated/
│   │   │   │   └── 51aaa87c-7f33-4bf3-89e8-a599edc0557a/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-correction-unknown-desktop.png
│   │   │   │   │   ├── 01-main-desktop.prompt.md
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanSync.can
│   │   │   ├── CanSync.md
│   │   │   ├── CanSync.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanTable/
│   │   │   ├── can.generated/
│   │   │   │   ├── 2a49de55-dd63-4d9e-a665-73f48878bde5/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   └── u1/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-main-desktop.png
│   │   │   │   │   ├── 01-main-desktop.prompt.md
│   │   │   │   │   ├── 02-host-queue-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanTable.can
│   │   │   ├── CanTable.md
│   │   │   ├── CanTable.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanTime/
│   │   │   ├── can.generated/
│   │   │   │   └── 5ed13954-bed0-424b-99dc-1770802af07a/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-main-desktop.prompt.md
│   │   │   │   │   ├── 01-own-time-desktop.png
│   │   │   │   │   ├── 02-period-review-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanTime.can
│   │   │   ├── CanTime.md
│   │   │   ├── CanTime.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanTrade/
│   │   │   ├── can.generated/
│   │   │   │   ├── 0defde68-0415-4786-a33b-3ee5ce9892df/
│   │   │   │   │   ├── contributions.can
│   │   │   │   │   ├── server.js
│   │   │   │   │   ├── source-behavior.can.txt
│   │   │   │   │   └── unit.json
│   │   │   │   └── 96aca566-8f03-4011-bd9f-1cf5d879db01/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-community-listings-desktop.png
│   │   │   │   │   ├── 01-main-desktop.prompt.md
│   │   │   │   │   ├── 02-moderation-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanTrade.can
│   │   │   ├── CanTrade.md
│   │   │   ├── CanTrade.mjs
│   │   │   └── playwright.config.ts
│   │   ├── CanVolunteer/
│   │   │   ├── can.generated/
│   │   │   │   └── b486bc2f-9227-4782-925a-ce5c8fe2810d/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   ├── references/
│   │   │   │   │   ├── 01-activities-desktop.png
│   │   │   │   │   ├── 01-main-desktop.prompt.md
│   │   │   │   │   ├── 02-coordination-desktop.png
│   │   │   │   │   ├── 03-own-assignments-desktop.png
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── prompts.md
│   │   │   │   ├── README.md
│   │   │   │   └── app.spec.ts
│   │   │   ├── CanVolunteer.can
│   │   │   ├── CanVolunteer.md
│   │   │   ├── CanVolunteer.mjs
│   │   │   └── playwright.config.ts
│   │   └── CanWorkbench/
│   │       ├── can.generated/
│   │       │   └── b64e3711-939b-4f97-be3a-efdec03db43e/
│   │       │       ├── style.css
│   │       │       └── unit.json
│   │       ├── playwright/
│   │       │   ├── references/
│   │       │   │   ├── 01-main-desktop.prompt.md
│   │       │   │   ├── 01-proposal-review-desktop.png
│   │       │   │   ├── README.md
│   │       │   │   └── prompts.md
│   │       │   ├── README.md
│   │       │   └── app.spec.ts
│   │       ├── CanWorkbench.can
│   │       ├── CanWorkbench.md
│   │       ├── CanWorkbench.mjs
│   │       └── playwright.config.ts
│   ├── shared/
│   │   ├── Employees.can
│   │   ├── Locations.can
│   │   └── Suppliers.can
│   ├── tools/
│   │   ├── organize.py
│   │   └── test_organize.py
│   ├── .gitignore
│   ├── ADMIN_SURFACES.md
│   ├── GENERATION_DRAFTS.md
│   ├── MIGRATION.md
│   ├── PORTFOLIO.md
│   ├── README.md
│   ├── UI_REFERENCES.md
│   ├── WORKSPACE_OPERATOR.md
│   └── can.gen.toml
├── editors/
│   └── vscode/
│       ├── .empty-typeroot/
│       │   └── .gitkeep
│       ├── images/
│       │   ├── previews/
│       │   │   ├── README.md
│       │   │   ├── browser-dark-dark-512.png
│       │   │   ├── browser-dark-white-512.png
│       │   │   ├── browser-light-dark-512.png
│       │   │   ├── browser-light-white-512.png
│       │   │   ├── browser-media-verification.json
│       │   │   ├── dark-dark-16.png
│       │   │   ├── dark-dark-48.png
│       │   │   ├── dark-dark-512.png
│       │   │   ├── dark-white-16.png
│       │   │   ├── dark-white-48.png
│       │   │   ├── dark-white-512.png
│       │   │   ├── file-icon-offset.png
│       │   │   ├── file-icon-verification.json
│       │   │   ├── geometry-verification.json
│       │   │   ├── light-dark-16.png
│       │   │   ├── light-dark-48.png
│       │   │   ├── light-dark-512.png
│       │   │   ├── light-white-16.png
│       │   │   ├── light-white-48.png
│       │   │   ├── light-white-512.png
│       │   │   ├── master-dark-1254.png
│       │   │   ├── package-verification.json
│       │   │   ├── renderer-comparison.json
│       │   │   ├── side-by-side-1254.png
│       │   │   ├── small-sizes.png
│       │   │   ├── themes-512.png
│       │   │   ├── vector-dark-1254.png
│       │   │   └── vector-transparent-1254.png
│       │   ├── file-icon-dark.svg
│       │   ├── file-icon-light.svg
│       │   ├── icon-dark.png
│       │   ├── icon.png
│       │   └── logo.svg
│       ├── src/
│       │   ├── client.ts
│       │   └── extension.ts
│       ├── syntaxes/
│       │   └── can.tmLanguage.json
│       ├── test/
│       │   ├── client-currentness.cjs
│       │   ├── client-lifecycle-process.cjs
│       │   ├── client-lifecycle.cjs
│       │   ├── editor-host.cjs
│       │   ├── highlighting-editor-host.cjs
│       │   ├── language-configuration.cjs
│       │   ├── lsp-capabilities.can
│       │   ├── lsp-capabilities.cjs
│       │   ├── lsp-codeaction.can
│       │   ├── server-startup.cjs
│       │   └── workspace-editor-host.cjs
│       ├── .vscodeignore
│       ├── LICENSE
│       ├── PALETTE.md
│       ├── README.md
│       ├── check-highlighting.cjs
│       ├── generate-file-icons.cjs
│       ├── language-configuration.json
│       ├── package.json
│       └── token-colors.json
├── examples/
│   ├── expenseflow-demo/
│   │   ├── README.md
│   │   ├── demo.mjs
│   │   ├── expenses.policy.json
│   │   └── prove.mjs
│   ├── ExpenseFlow.can
│   ├── Generation.can
│   ├── TeamTasks.can
│   └── Todo.can
├── host/
│   ├── src/
│   │   └── main.rs
│   ├── Cargo.lock
│   └── Cargo.toml
├── output/
│   ├── draft-frontends/
│   │   ├── corpus/
│   │   │   ├── audit.json
│   │   │   └── index.html
│   │   ├── help-office/
│   │   │   ├── desktop-01.png
│   │   │   ├── mobile-01.png
│   │   │   ├── report.html
│   │   │   └── report.json
│   │   ├── model-free-preview/
│   │   │   ├── desktop-01.png
│   │   │   ├── mobile-01.png
│   │   │   ├── report.html
│   │   │   └── report.json
│   │   ├── help-office-functional.json
│   │   └── runtime-snapshot.json
│   ├── editor/
│   │   ├── invariant-category-0.1.7.json
│   │   └── invariant-migration-0.1.6.json
│   └── prompt-pipeline/
│       ├── generation-prompt-pipeline-07c18806-ff0e-4f7f-a591-e92a77b3135f.json
│       ├── generation-prompt-pipeline-297ad363-dff2-4579-9296-13c6de3bca74.json
│       ├── generation-prompt-pipeline-2f999bf1-8550-4062-821f-1345154d054a.json
│       ├── generation-prompt-pipeline-5312a08c-7ae6-4bfb-8a0e-675335c78774.json
│       ├── generation-prompt-pipeline-9d83d3ab-264c-46cc-ab99-b93885694b6a.json
│       ├── generation-prompt-pipeline-e407e6bd-fde5-4282-81f3-c363f6e79749.json
│       ├── generation-prompt-pipeline-f7f2d522-6fb2-4941-b802-bf61732e60af.json
│       └── saved-edit.json
├── packages/
│   ├── cloudflare/
│   │   ├── conformance/
│   │   │   └── preparation/
│   │   │       ├── cases.json
│   │   │       ├── differential.mjs
│   │   │       └── workloads.mjs
│   │   ├── preparation/
│   │   │   ├── src/
│   │   │   │   ├── artifact.rs
│   │   │   │   ├── compatibility.rs
│   │   │   │   ├── failures.rs
│   │   │   │   ├── input.rs
│   │   │   │   ├── job.rs
│   │   │   │   ├── lib.rs
│   │   │   │   ├── main.rs
│   │   │   │   ├── modules.rs
│   │   │   │   ├── plan.rs
│   │   │   │   ├── protocol.rs
│   │   │   │   ├── release.rs
│   │   │   │   ├── render.rs
│   │   │   │   └── review.rs
│   │   │   ├── tests/
│   │   │   │   ├── artifact.rs
│   │   │   │   ├── compatibility.rs
│   │   │   │   ├── modules.rs
│   │   │   │   ├── modules_facts.rs
│   │   │   │   ├── outputs.rs
│   │   │   │   ├── plan.rs
│   │   │   │   ├── protocol.rs
│   │   │   │   ├── release.rs
│   │   │   │   └── vectors.rs
│   │   │   ├── Cargo.lock
│   │   │   ├── Cargo.toml
│   │   │   ├── build.rs
│   │   │   └── rust-toolchain.toml
│   │   ├── scripts/
│   │   │   ├── build-preparation.mjs
│   │   │   ├── build-soda-host.mjs
│   │   │   ├── emit-native-catalog.mjs
│   │   │   ├── package-preparation.mjs
│   │   │   └── verify-preparation.mjs
│   │   ├── src/
│   │   │   ├── cli/
│   │   │   │   ├── artifact-defaults.ts
│   │   │   │   ├── command-lifetime.ts
│   │   │   │   ├── docs.ts
│   │   │   │   ├── gen.ts
│   │   │   │   ├── native-handoff.ts
│   │   │   │   ├── platform.ts
│   │   │   │   ├── soda-build.ts
│   │   │   │   ├── soda-runtime.ts
│   │   │   │   ├── soda.ts
│   │   │   │   └── source-workflow.ts
│   │   │   ├── deploy/
│   │   │   │   ├── activate.ts
│   │   │   │   ├── bundle-validation.ts
│   │   │   │   ├── bundle.ts
│   │   │   │   ├── compat.ts
│   │   │   │   ├── installed.ts
│   │   │   │   ├── module-imports.ts
│   │   │   │   ├── module-maps.ts
│   │   │   │   ├── owned-bundle-entry.ts
│   │   │   │   ├── owned-bundle.ts
│   │   │   │   ├── package-assets.ts
│   │   │   │   ├── plan.ts
│   │   │   │   ├── producer-files.ts
│   │   │   │   ├── render.ts
│   │   │   │   ├── review.ts
│   │   │   │   ├── soda-contract.ts
│   │   │   │   ├── soda-lifetime.ts
│   │   │   │   ├── soda-run.ts
│   │   │   │   ├── soda-setup.ts
│   │   │   │   ├── soda-workerd.ts
│   │   │   │   ├── soda.ts
│   │   │   │   └── workerd-config.ts
│   │   │   ├── generation/
│   │   │   │   ├── acceptance-cleanup.ts
│   │   │   │   ├── acceptance.ts
│   │   │   │   ├── adapters.ts
│   │   │   │   ├── association.ts
│   │   │   │   ├── config.ts
│   │   │   │   ├── controls.ts
│   │   │   │   ├── journal.ts
│   │   │   │   ├── leases.ts
│   │   │   │   ├── lifecycle.ts
│   │   │   │   ├── mcp.ts
│   │   │   │   ├── native-capture.ts
│   │   │   │   ├── protocol.ts
│   │   │   │   └── records.ts
│   │   │   ├── preparation/
│   │   │   │   ├── build-adapter.ts
│   │   │   │   ├── executable-manifest.ts
│   │   │   │   ├── executable.ts
│   │   │   │   ├── host.ts
│   │   │   │   ├── inputs.ts
│   │   │   │   ├── protocol.ts
│   │   │   │   └── publication.ts
│   │   │   ├── release/
│   │   │   │   ├── manifest.ts
│   │   │   │   ├── stamp.ts
│   │   │   │   └── version.ts
│   │   │   ├── runtime/
│   │   │   │   ├── artifact.ts
│   │   │   │   ├── assembly-verification.ts
│   │   │   │   ├── auth-rate-limiter.ts
│   │   │   │   ├── bound-dispatch.ts
│   │   │   │   ├── bound-files.ts
│   │   │   │   ├── bound-images.ts
│   │   │   │   ├── bound-judgment.ts
│   │   │   │   ├── bound-mail.ts
│   │   │   │   ├── bound-text-generation.ts
│   │   │   │   ├── browser-tools.ts
│   │   │   │   ├── checkout-scratch.test-support.ts
│   │   │   │   ├── cohort-tick.ts
│   │   │   │   ├── context.ts
│   │   │   │   ├── d1-file-inventory.ts
│   │   │   │   ├── derived-columns.integration.test.ts
│   │   │   │   ├── env-assembly.ts
│   │   │   │   ├── example-bindings.test-support.ts
│   │   │   │   ├── example-bindings.ts
│   │   │   │   ├── example-fixture-imports.ts
│   │   │   │   ├── export-downloads.ts
│   │   │   │   ├── file-inventory.ts
│   │   │   │   ├── file-retirement.ts
│   │   │   │   ├── file-staging.ts
│   │   │   │   ├── generated-views.ts
│   │   │   │   ├── generation-callback-origin.ts
│   │   │   │   ├── given-unique-keys.ts
│   │   │   │   ├── grant-route.ts
│   │   │   │   ├── input-choices.ts
│   │   │   │   ├── invocation-errors.ts
│   │   │   │   ├── invoke.ts
│   │   │   │   ├── mcp-permissions.ts
│   │   │   │   ├── mcp-registry.ts
│   │   │   │   ├── modules.ts
│   │   │   │   ├── native-cross-model-promotion.integration.test.ts
│   │   │   │   ├── native-dev.test-support.ts
│   │   │   │   ├── native-event-send-due.integration.test.ts
│   │   │   │   ├── native-event-send-notice.integration.test.ts
│   │   │   │   ├── native-event-send-reminder.integration.test.ts
│   │   │   │   ├── native-invoice-collect.integration.test.ts
│   │   │   │   ├── native-invoice-issue.integration.test.ts
│   │   │   │   ├── native-invoice-overdue.integration.test.ts
│   │   │   │   ├── native-leave-decide.integration.test.ts
│   │   │   │   ├── native-leave-request.integration.test.ts
│   │   │   │   ├── native-local-rules-d1.integration.test.ts
│   │   │   │   ├── native-local-rules.integration.test.ts
│   │   │   │   ├── native-member-retry-collection.integration.test.ts
│   │   │   │   ├── native-membership.ts
│   │   │   │   ├── native-observe-venue.integration.test.ts
│   │   │   │   ├── native-preview.test-support.ts
│   │   │   │   ├── native-read-boolean-graph.integration.test.ts
│   │   │   │   ├── native-read-boolean.integration.test.ts
│   │   │   │   ├── native-read-boolean.ts
│   │   │   │   ├── native-records.ts
│   │   │   │   ├── native-refer-reject-source.integration.test.ts
│   │   │   │   ├── native-reference-arrays-d1.integration.test.ts
│   │   │   │   ├── native-rent-notice.integration.test.ts
│   │   │   │   ├── native-rent-refund-movement-credit.integration.test.ts
│   │   │   │   ├── native-rent-resource-report.integration.test.ts
│   │   │   │   ├── native-rule-owner-search.integration.test.ts
│   │   │   │   ├── native-scenario-receipts-d1.integration.test.ts
│   │   │   │   ├── native-scenario-require.ts
│   │   │   │   ├── native-send-nullable-narrowing.integration.test.ts
│   │   │   │   ├── native-staff-can-work.integration.test.ts
│   │   │   │   ├── native-success-renewal.integration.test.ts
│   │   │   │   ├── native-ui-query.ts
│   │   │   │   ├── native-value-schema.ts
│   │   │   │   ├── native-viewer-first.integration.test.ts
│   │   │   │   ├── opaque-file-staging.ts
│   │   │   │   ├── original-source.testing.ts
│   │   │   │   ├── page-cursor.ts
│   │   │   │   ├── page-preferences.ts
│   │   │   │   ├── prepared-validation.ts
│   │   │   │   ├── promptlab-activation-collision.integration.test.ts
│   │   │   │   ├── promptlab-native-acceptance.integration.test.ts
│   │   │   │   ├── queue-file-retention.ts
│   │   │   │   ├── queue-runtime.ts
│   │   │   │   ├── r2-files.ts
│   │   │   │   ├── receipt-progress.ts
│   │   │   │   ├── receipt-staging.ts
│   │   │   │   ├── resource-dispatch.ts
│   │   │   │   ├── resource-host.ts
│   │   │   │   ├── resource-lifetime.ts
│   │   │   │   ├── root-authority-directory.ts
│   │   │   │   ├── root-authority-http.ts
│   │   │   │   ├── root-authority.ts
│   │   │   │   ├── scenario-receipt-frame.ts
│   │   │   │   ├── soda-admin.ts
│   │   │   │   ├── soda-application.ts
│   │   │   │   ├── soda-d1.ts
│   │   │   │   ├── sourcemap.ts
│   │   │   │   ├── stdlib.ts
│   │   │   │   ├── t34c-work-installed.integration.test.ts
│   │   │   │   ├── text-generation-progress.ts
│   │   │   │   └── worker-files.ts
│   │   │   ├── upgrade/
│   │   │   │   └── apply.ts
│   │   │   ├── worker/
│   │   │   │   ├── assembly.ts
│   │   │   │   ├── entry.ts
│   │   │   │   └── main.ts
│   │   │   ├── distribution.ts
│   │   │   └── index.ts
│   │   ├── test/
│   │   │   ├── fixtures/
│   │   │   │   ├── teamtasks-activate/
│   │   │   │   │   ├── teamtasks-bad.artifact.json
│   │   │   │   │   ├── teamtasks-bad.descriptor.json
│   │   │   │   │   ├── teamtasks-bad.local.environment.json
│   │   │   │   │   ├── teamtasks-bad.target.json
│   │   │   │   │   ├── teamtasks-good.artifact.json
│   │   │   │   │   ├── teamtasks-good.descriptor.json
│   │   │   │   │   ├── teamtasks-good.local.environment.json
│   │   │   │   │   ├── teamtasks-good.store.json
│   │   │   │   │   └── teamtasks-good.target.json
│   │   │   │   ├── agreements-due-transport-probe.can
│   │   │   │   ├── agreements-notice-transport-probe.can
│   │   │   │   ├── appointments-reminder-transport-probe.can
│   │   │   │   ├── authority-report-helpers.can
│   │   │   │   ├── authority-report-shop.can
│   │   │   │   ├── conditional-unique-office.can
│   │   │   │   ├── conditional-unique-original-office.can
│   │   │   │   ├── conditional-unique.can
│   │   │   │   ├── contained-first-domain.can
│   │   │   │   ├── event-observe-owner-probe.can
│   │   │   │   ├── file-collection-download.can
│   │   │   │   ├── file-collection-source-preview.can
│   │   │   │   ├── file-page-source.can
│   │   │   │   ├── generated-machines.can
│   │   │   │   ├── generated-machines.json
│   │   │   │   ├── hook-first-delivery-private-presence.can
│   │   │   │   ├── hook-first-delivery-private-unused.can
│   │   │   │   ├── hook-first-delivery-private.can
│   │   │   │   ├── hook-first-delivery.can
│   │   │   │   ├── hook-parent-joint-helpers.can
│   │   │   │   ├── hook-parent-joint.can
│   │   │   │   ├── hook-parent-reads.can
│   │   │   │   ├── hook-reference-joint-helpers.can
│   │   │   │   ├── hook-reference-joint.can
│   │   │   │   ├── import-policy-contract.json
│   │   │   │   ├── input-choices.json
│   │   │   │   ├── invoice-collect-owner-probe.can
│   │   │   │   ├── invoice-created-send-source.can
│   │   │   │   ├── invoice-credit-loop-source.can
│   │   │   │   ├── invoice-issue-owner-probe.can
│   │   │   │   ├── invoice-overdue-owner-probe.can
│   │   │   │   ├── invoice-terminal-owner-probe.can
│   │   │   │   ├── invoice-void-source.can
│   │   │   │   ├── leave-decide-owner-probe.can
│   │   │   │   ├── leave-request-owner-probe.can
│   │   │   │   ├── maintain-inspect-owner-probe.can
│   │   │   │   ├── maintain-remind-owner-probe.can
│   │   │   │   ├── map-composition-contract.json
│   │   │   │   ├── member-assign-owner-probe.can
│   │   │   │   ├── member-remove-owner-probe.can
│   │   │   │   ├── member-retry-collection-owner-probe.can
│   │   │   │   ├── member-term-owner-probe.can
│   │   │   │   ├── model-rule-activation.can
│   │   │   │   ├── model-rule-activation.json
│   │   │   │   ├── native-callback-diagnostics.can
│   │   │   │   ├── native-composed-file-retirement.can
│   │   │   │   ├── native-conditional-navigation.can
│   │   │   │   ├── native-contained-create.can
│   │   │   │   ├── native-created-model-result.can
│   │   │   │   ├── native-created-result-required-set.can
│   │   │   │   ├── native-cross-model-handoff.can
│   │   │   │   ├── native-cross-model-promotion.can
│   │   │   │   ├── native-explicit-call-inputs.can
│   │   │   │   ├── native-file-deferred.can
│   │   │   │   ├── native-file-retirement.can
│   │   │   │   ├── native-first-lookup.can
│   │   │   │   ├── native-gallery.can
│   │   │   │   ├── native-generation-receiving.can
│   │   │   │   ├── native-guarded-email.can
│   │   │   │   ├── native-guarded-text-generation.can
│   │   │   │   ├── native-guarded-user-email.can
│   │   │   │   ├── native-history.can
│   │   │   │   ├── native-identity-removal-source.can
│   │   │   │   ├── native-literal-format.can
│   │   │   │   ├── native-model-guarded-email.can
│   │   │   │   ├── native-nullable-enum-membership.can
│   │   │   │   ├── native-parent-helper.can
│   │   │   │   ├── native-parent-model-guarded-email.can
│   │   │   │   ├── native-parent-timezone.can
│   │   │   │   ├── native-qualified-enum-case.can
│   │   │   │   ├── native-queue-only.can
│   │   │   │   ├── native-read-boolean-graph.can
│   │   │   │   ├── native-read-boolean.can
│   │   │   │   ├── native-ref-enum-unique.can
│   │   │   │   ├── native-reference-chain-result.can
│   │   │   │   ├── native-reference-model-result.can
│   │   │   │   ├── native-reference-timezone.can
│   │   │   │   ├── native-root-authority.can
│   │   │   │   ├── native-root-files.can
│   │   │   │   ├── native-root-queue.can
│   │   │   │   ├── native-send-nullable-narrowing.can
│   │   │   │   ├── native-send-partial-refusal.can
│   │   │   │   ├── native-source-emit-data.can
│   │   │   │   ├── native-source-policy-projection.can
│   │   │   │   ├── native-source-require-cancel.can
│   │   │   │   ├── native-source-require-emit.can
│   │   │   │   ├── native-source-require-schedule.can
│   │   │   │   ├── native-source-require-send.can
│   │   │   │   ├── native-source-send-data.can
│   │   │   │   ├── native-stored-file-call.can
│   │   │   │   ├── native-values-interval-require.can
│   │   │   │   ├── native-viewer-first.can
│   │   │   │   ├── propose-revise-owner-probe.can
│   │   │   │   ├── raw-source-map-contract.json
│   │   │   │   ├── refer-reject-source-owner-probe.can
│   │   │   │   ├── rent-notice-owner-probe.can
│   │   │   │   ├── rent-refund-movement-credit-owner-probe.can
│   │   │   │   ├── rent-resource-report-owner-probe.can
│   │   │   │   ├── rule-owner-all-helper-any-first-bound.can
│   │   │   │   ├── rule-owner-all-helper-any-first-copied-emit.can
│   │   │   │   ├── rule-owner-all-helper-any-first-copied-parent.can
│   │   │   │   ├── rule-owner-all-helper-any-first.can
│   │   │   │   ├── rule-owner-any-first-target-other-parent.can
│   │   │   │   ├── rule-owner-any-first-target.can
│   │   │   │   ├── rule-owner-any-first.can
│   │   │   │   ├── rule-owner-direct-child.can
│   │   │   │   ├── rule-owner-first-copy-unproved.can
│   │   │   │   ├── rule-owner-first-target-no-read.can
│   │   │   │   ├── rule-owner-first-target-order-only-unscoped.can
│   │   │   │   ├── rule-owner-first-target-order-only.can
│   │   │   │   ├── rule-owner-first-target-suffix-unproved.can
│   │   │   │   ├── rule-owner-first-target-suffix.can
│   │   │   │   ├── rule-owner-first-target.can
│   │   │   │   ├── rule-owner-helper-child-copy-unproved.can
│   │   │   │   ├── rule-owner-helper-child-no-membership.can
│   │   │   │   ├── rule-owner-helper-child.can
│   │   │   │   ├── rule-owner-leading-helper-cross-handoff.can
│   │   │   │   ├── rule-owner-leading-helper-field.can
│   │   │   │   ├── rule-owner-no-membership.can
│   │   │   │   ├── rule-owner-require.can
│   │   │   │   ├── rule-owner-unreadable-anchor.can
│   │   │   │   ├── smoke-worker.mjs
│   │   │   │   ├── staff-can-work-employee.can
│   │   │   │   ├── staff-can-work-shop.can
│   │   │   │   ├── success-renewal-owner-probe.can
│   │   │   │   ├── typed-authorized-reads.can
│   │   │   │   ├── typed-authorized-reads.json
│   │   │   │   ├── typed-calendar-durations.can
│   │   │   │   ├── typed-calendar-durations.json
│   │   │   │   ├── typed-cohort-journey.can
│   │   │   │   ├── typed-cohort-journey.json
│   │   │   │   ├── typed-context-scopes.can
│   │   │   │   ├── typed-context-scopes.json
│   │   │   │   ├── typed-delivery-observer.can
│   │   │   │   ├── typed-delivery-observer.json
│   │   │   │   ├── typed-durable-admission.can
│   │   │   │   ├── typed-durable-admission.json
│   │   │   │   ├── typed-durable-send.can
│   │   │   │   ├── typed-durable-send.json
│   │   │   │   ├── typed-exact-numbers.can
│   │   │   │   ├── typed-exact-numbers.json
│   │   │   │   ├── typed-file-journey.can
│   │   │   │   ├── typed-file-journey.json
│   │   │   │   ├── typed-generation-progress.can
│   │   │   │   ├── typed-generation-progress.json
│   │   │   │   ├── typed-images-progress.can
│   │   │   │   ├── typed-images-progress.json
│   │   │   │   ├── typed-keyed-schedule.can
│   │   │   │   ├── typed-keyed-schedule.json
│   │   │   │   ├── typed-operation-forms.can
│   │   │   │   ├── typed-operation-forms.json
│   │   │   │   ├── typed-private-cohort.can
│   │   │   │   ├── typed-private-cohort.json
│   │   │   │   ├── typed-scenario-values.can
│   │   │   │   ├── typed-scenario-values.json
│   │   │   │   ├── typed-state-page.can
│   │   │   │   ├── typed-state-page.json
│   │   │   │   ├── typed-stored-reference.can
│   │   │   │   ├── typed-temporal-arrays.can
│   │   │   │   ├── typed-temporal-arrays.json
│   │   │   │   ├── typed-text-booleans.can
│   │   │   │   ├── typed-text-booleans.json
│   │   │   │   ├── typed-user-references.can
│   │   │   │   └── typed-user-references.json
│   │   │   ├── app-owned-preview.integration.test.ts
│   │   │   ├── compiler-check.integration.test.ts
│   │   │   ├── crm-promotion-source.ts
│   │   │   ├── customer-recover-source.ts
│   │   │   ├── durable-files-sqlite.integration.test.ts
│   │   │   ├── first-profile-browser.integration.test.ts
│   │   │   ├── identity-bootstrap.integration.test.ts
│   │   │   ├── model-free-preview.integration.test.ts
│   │   │   ├── native-original-canchat.pending.ts
│   │   │   ├── partner-share-source.ts
│   │   │   ├── purchase-source.ts
│   │   │   └── soda-writer.integration.test.ts
│   │   ├── README.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── contracts/
│   │   ├── src/
│   │   │   ├── browser/
│   │   │   │   └── chromium.ts
│   │   │   ├── artifact.ts
│   │   │   ├── deployment-assets.ts
│   │   │   ├── deployment.ts
│   │   │   ├── diagnostic.ts
│   │   │   ├── distribution.ts
│   │   │   ├── examples.ts
│   │   │   ├── files.ts
│   │   │   ├── identity.ts
│   │   │   ├── index.ts
│   │   │   ├── presentation.ts
│   │   │   ├── reference.ts
│   │   │   ├── services.ts
│   │   │   ├── state.ts
│   │   │   ├── values.ts
│   │   │   ├── wire.ts
│   │   │   └── work.ts
│   │   ├── README.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── files/
│   │   ├── src/
│   │   │   ├── finalize/
│   │   │   │   └── index.ts
│   │   │   ├── host/
│   │   │   │   ├── durable-sqlite.ts
│   │   │   │   ├── sqlite-core.ts
│   │   │   │   └── sqlite.ts
│   │   │   ├── provenance/
│   │   │   │   └── index.ts
│   │   │   ├── retention/
│   │   │   │   └── index.ts
│   │   │   ├── upload/
│   │   │   │   ├── fs-blob-store.ts
│   │   │   │   └── index.ts
│   │   │   ├── bridge.ts
│   │   │   ├── catalog.ts
│   │   │   ├── distribution.ts
│   │   │   ├── index.ts
│   │   │   ├── ports.ts
│   │   │   └── scenarios.ts
│   │   ├── test/
│   │   │   └── helpers.ts
│   │   ├── .gitignore
│   │   ├── README.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── identity/
│   │   ├── src/
│   │   │   ├── accounts/
│   │   │   │   ├── passwords.ts
│   │   │   │   ├── recovery.ts
│   │   │   │   └── registration.ts
│   │   │   ├── authentication/
│   │   │   │   ├── audience.ts
│   │   │   │   ├── context.ts
│   │   │   │   ├── grants.ts
│   │   │   │   ├── oauth.ts
│   │   │   │   └── revocation.ts
│   │   │   ├── sessions/
│   │   │   │   ├── comparison-node.ts
│   │   │   │   ├── comparison-worker.ts
│   │   │   │   ├── comparison.ts
│   │   │   │   ├── cookies.ts
│   │   │   │   ├── csrf.ts
│   │   │   │   ├── presession.ts
│   │   │   │   └── tokens.ts
│   │   │   ├── storage/
│   │   │   │   ├── bootstrap.ts
│   │   │   │   └── d1.ts
│   │   │   ├── teams/
│   │   │   │   ├── invitations.ts
│   │   │   │   ├── membership.ts
│   │   │   │   ├── removal-occurrence.ts
│   │   │   │   ├── roles.ts
│   │   │   │   └── selection.ts
│   │   │   ├── distribution.ts
│   │   │   ├── index.ts
│   │   │   ├── membership-snapshot.ts
│   │   │   ├── ports.ts
│   │   │   └── testing.ts
│   │   ├── test/
│   │   │   └── fixtures/
│   │   │       ├── revoked-session.json
│   │   │       └── two-user-team.json
│   │   ├── .gitignore
│   │   ├── README.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── interfaces/
│   │   ├── src/
│   │   │   ├── docs/
│   │   │   │   └── reference.ts
│   │   │   ├── envelope/
│   │   │   │   ├── owned-selection.ts
│   │   │   │   ├── prepared.ts
│   │   │   │   ├── refs.ts
│   │   │   │   ├── validate.ts
│   │   │   │   └── versions.ts
│   │   │   ├── errors/
│   │   │   │   ├── envelope.ts
│   │   │   │   ├── logging.ts
│   │   │   │   ├── redact.ts
│   │   │   │   └── safe.ts
│   │   │   ├── http/
│   │   │   │   ├── assets.ts
│   │   │   │   ├── auth.ts
│   │   │   │   ├── browser-auth.ts
│   │   │   │   ├── canonical-json.ts
│   │   │   │   ├── context.ts
│   │   │   │   ├── csv.ts
│   │   │   │   ├── export.ts
│   │   │   │   ├── form-binding.ts
│   │   │   │   ├── formErrors.ts
│   │   │   │   ├── forms.ts
│   │   │   │   ├── fragments.ts
│   │   │   │   ├── input-choices.ts
│   │   │   │   ├── limits.ts
│   │   │   │   ├── operations.ts
│   │   │   │   ├── pages.ts
│   │   │   │   ├── prepared-validation.ts
│   │   │   │   ├── presentation.ts
│   │   │   │   ├── print.ts
│   │   │   │   └── routes.ts
│   │   │   ├── ingress/
│   │   │   │   ├── identity-removal.ts
│   │   │   │   ├── mapping.ts
│   │   │   │   └── routes.ts
│   │   │   ├── instrumentation/
│   │   │   │   └── intake.ts
│   │   │   ├── internal/
│   │   │   │   ├── input-admission.ts
│   │   │   │   └── prepared-binding.ts
│   │   │   ├── mcp/
│   │   │   │   ├── discovery.ts
│   │   │   │   ├── prepared.ts
│   │   │   │   ├── schemas.ts
│   │   │   │   ├── server.ts
│   │   │   │   └── tools.ts
│   │   │   ├── oauth/
│   │   │   │   ├── metadata.ts
│   │   │   │   └── routes.ts
│   │   │   ├── projection/
│   │   │   │   └── project.ts
│   │   │   ├── uploads/
│   │   │   │   ├── kernel.ts
│   │   │   │   ├── principals.ts
│   │   │   │   └── routes.ts
│   │   │   ├── distribution.ts
│   │   │   ├── index.ts
│   │   │   ├── ports.ts
│   │   │   └── testing.ts
│   │   ├── test/
│   │   │   ├── fixtures/
│   │   │   │   ├── action-handle.json
│   │   │   │   ├── bool-page-source.can
│   │   │   │   ├── bool-toggle-filters-compiled.json
│   │   │   │   ├── business-error.json
│   │   │   │   ├── enum-page-source.can
│   │   │   │   ├── factory-shapes-consumer.can
│   │   │   │   ├── mutation-envelope.json
│   │   │   │   ├── standalone-filter-preference.can
│   │   │   │   ├── text-page-source.can
│   │   │   │   └── upload-intent.json
│   │   │   ├── integration-lifecycle.test.ts
│   │   │   └── integration-parity.test.ts
│   │   ├── .gitignore
│   │   ├── README.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── services/
│   │   ├── src/
│   │   │   ├── http/
│   │   │   │   ├── client.ts
│   │   │   │   ├── errors.ts
│   │   │   │   └── pagination.ts
│   │   │   ├── internal/
│   │   │   │   ├── controlled-http.ts
│   │   │   │   └── scenario-admission.ts
│   │   │   ├── judgments/
│   │   │   │   ├── harness.ts
│   │   │   │   ├── specification.ts
│   │   │   │   └── systemone.ts
│   │   │   ├── mail/
│   │   │   │   ├── adapter.ts
│   │   │   │   └── redact.ts
│   │   │   ├── media/
│   │   │   │   ├── comfyui.ts
│   │   │   │   ├── harness.ts
│   │   │   │   └── mapping.ts
│   │   │   ├── models/
│   │   │   │   ├── harness.ts
│   │   │   │   └── ollama.ts
│   │   │   ├── catalog.ts
│   │   │   ├── distribution.ts
│   │   │   ├── index.ts
│   │   │   ├── ports.ts
│   │   │   └── scenarios.ts
│   │   ├── .gitignore
│   │   ├── README.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── state/
│   │   ├── scripts/
│   │   │   └── build-do-test-worker.mjs
│   │   ├── src/
│   │   │   ├── effects/
│   │   │   │   ├── delivery.ts
│   │   │   │   ├── guards.ts
│   │   │   │   ├── staging.ts
│   │   │   │   └── transition.ts
│   │   │   ├── fanout/
│   │   │   │   ├── cohort.ts
│   │   │   │   ├── lifecycle.ts
│   │   │   │   ├── membership.ts
│   │   │   │   ├── navigation.ts
│   │   │   │   ├── outcome.ts
│   │   │   │   ├── progress.ts
│   │   │   │   └── tables.ts
│   │   │   ├── internal/
│   │   │   │   ├── json.ts
│   │   │   │   ├── machine.ts
│   │   │   │   ├── own-data.ts
│   │   │   │   └── unique-value.ts
│   │   │   ├── invocation/
│   │   │   │   ├── admission.ts
│   │   │   │   ├── context.ts
│   │   │   │   ├── crud-receipt.ts
│   │   │   │   ├── dispatch-membership.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── invoke.ts
│   │   │   │   ├── prepared-inputs.ts
│   │   │   │   ├── registry.ts
│   │   │   │   ├── replay.ts
│   │   │   │   ├── scenario-file-assignment.ts
│   │   │   │   ├── scenario-membership-plan.ts
│   │   │   │   ├── scenario-narrowed-field.ts
│   │   │   │   ├── scenario-plan.ts
│   │   │   │   ├── scenario-query-any.ts
│   │   │   │   ├── scenario-query-plan.ts
│   │   │   │   ├── scenario-query-selection.ts
│   │   │   │   ├── scenario-receipt-decoding.ts
│   │   │   │   ├── scenario-receipt.ts
│   │   │   │   ├── scenario-stored-reference.ts
│   │   │   │   └── scenario-stored-value.ts
│   │   │   ├── migration/
│   │   │   │   ├── activate.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── mapper.ts
│   │   │   │   ├── recover.ts
│   │   │   │   ├── retain.ts
│   │   │   │   ├── stage.ts
│   │   │   │   ├── transition.ts
│   │   │   │   └── validate.ts
│   │   │   ├── mutation/
│   │   │   │   ├── crud.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── model-policies.ts
│   │   │   │   ├── models.ts
│   │   │   │   ├── pipeline.ts
│   │   │   │   ├── source-finalization.ts
│   │   │   │   ├── t18-shop.artifact.ts
│   │   │   │   └── t18-shop.can
│   │   │   ├── policy/
│   │   │   │   ├── grants.ts
│   │   │   │   ├── membership-facts.ts
│   │   │   │   ├── roles.ts
│   │   │   │   └── row-subject.ts
│   │   │   ├── ports/
│   │   │   │   ├── file-reference-profile.ts
│   │   │   │   ├── file-references.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── model-lexical-snapshot.ts
│   │   │   │   ├── read.ts
│   │   │   │   ├── system.ts
│   │   │   │   └── transact.ts
│   │   │   ├── query/
│   │   │   │   ├── engine.ts
│   │   │   │   ├── history.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── order.ts
│   │   │   │   └── source-policy.ts
│   │   │   ├── receipt/
│   │   │   │   ├── authored-delivery.ts
│   │   │   │   ├── callback-diagnostics.ts
│   │   │   │   ├── grants.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── join.ts
│   │   │   │   ├── observer-loader.ts
│   │   │   │   ├── read-policy-membership.ts
│   │   │   │   └── tables.ts
│   │   │   ├── storage/
│   │   │   │   ├── d1.ts
│   │   │   │   ├── durable-object.ts
│   │   │   │   ├── file-reference-inventory.ts
│   │   │   │   ├── file-retirement.ts
│   │   │   │   ├── history-bounded-fixtures.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── memory.ts
│   │   │   │   ├── opaque-file-declarations.ts
│   │   │   │   ├── owner-router.ts
│   │   │   │   ├── port.ts
│   │   │   │   ├── schema.ts
│   │   │   │   └── sqlite-codecs.ts
│   │   │   ├── catalog.ts
│   │   │   ├── distribution.ts
│   │   │   ├── errors.ts
│   │   │   └── index.ts
│   │   ├── test/
│   │   │   ├── fanout/
│   │   │   │   └── test-driver.ts
│   │   │   ├── fixtures/
│   │   │   │   └── numeric-control/
│   │   │   │       ├── artifact.json
│   │   │   │       └── source.can
│   │   │   ├── invocation/
│   │   │   │   └── fixtures.ts
│   │   │   ├── migration/
│   │   │   │   └── fixtures.ts
│   │   │   ├── mutation/
│   │   │   │   └── fixtures.ts
│   │   │   ├── ports/
│   │   │   │   └── fixtures.ts
│   │   │   ├── query/
│   │   │   │   └── fixtures.ts
│   │   │   ├── storage/
│   │   │   │   ├── conformance.ts
│   │   │   │   └── do-test-worker.js
│   │   │   └── file-references-source.mjs
│   │   ├── .gitignore
│   │   ├── README.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── stdlib/
│   │   ├── src/
│   │   │   ├── distribution.ts
│   │   │   └── index.ts
│   │   ├── README.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── testkit/
│   │   ├── conformance/
│   │   │   └── ports/
│   │   │       ├── loader-smoke/
│   │   │       │   ├── src/
│   │   │       │   │   └── lib.rs
│   │   │       │   ├── Cargo.lock
│   │   │       │   ├── Cargo.toml
│   │   │       │   ├── build.rs
│   │   │       │   ├── host.mjs
│   │   │       │   └── workerd.mjs
│   │   │       ├── observations.mjs
│   │   │       └── transport-vectors.mjs
│   │   ├── src/
│   │   │   ├── assertions/
│   │   │   │   └── equal.ts
│   │   │   ├── browser/
│   │   │   │   └── chromium.ts
│   │   │   ├── fixtures/
│   │   │   │   ├── accounts.ts
│   │   │   │   ├── b2-delivery.ts
│   │   │   │   ├── b2-revocation.ts
│   │   │   │   ├── b2-storage.ts
│   │   │   │   ├── playback-worker.ts
│   │   │   │   ├── playback.ts
│   │   │   │   ├── recipes.ts
│   │   │   │   └── seeds.ts
│   │   │   ├── reporting/
│   │   │   │   └── report.ts
│   │   │   ├── runner/
│   │   │   │   ├── dispatch.ts
│   │   │   │   ├── loader.ts
│   │   │   │   ├── steps.ts
│   │   │   │   └── table.ts
│   │   │   ├── scopes/
│   │   │   │   └── local.ts
│   │   │   └── index.ts
│   │   ├── test/
│   │   │   └── fixtures/
│   │   │       └── scope-worker.mjs
│   │   ├── README.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── ui/
│   │   ├── scripts/
│   │   │   └── build-browser.mjs
│   │   ├── src/
│   │   │   ├── browser/
│   │   │   │   ├── bootstrap.ts
│   │   │   │   ├── export.ts
│   │   │   │   ├── gallery.ts
│   │   │   │   ├── instrumentation.ts
│   │   │   │   ├── polling.ts
│   │   │   │   ├── print.ts
│   │   │   │   └── style.css
│   │   │   ├── csv/
│   │   │   │   ├── confirm.ts
│   │   │   │   ├── grammar.ts
│   │   │   │   ├── parse.ts
│   │   │   │   └── preview.ts
│   │   │   ├── internal/
│   │   │   │   ├── action-groups.ts
│   │   │   │   ├── appearance-props.ts
│   │   │   │   ├── business-errors.ts
│   │   │   │   ├── collection-selection.ts
│   │   │   │   ├── draft-values.ts
│   │   │   │   ├── field-binding.ts
│   │   │   │   ├── file-link.ts
│   │   │   │   ├── menu-dialog.ts
│   │   │   │   └── native-text.ts
│   │   │   ├── appearance.ts
│   │   │   ├── catalog.ts
│   │   │   ├── client.ts
│   │   │   ├── collections.ts
│   │   │   ├── components.ts
│   │   │   ├── controls.ts
│   │   │   ├── distribution.ts
│   │   │   ├── escape.ts
│   │   │   ├── forms.ts
│   │   │   ├── groups.ts
│   │   │   ├── htmx.ts
│   │   │   ├── index.ts
│   │   │   ├── leaves.ts
│   │   │   ├── media.ts
│   │   │   ├── messages.ts
│   │   │   ├── navigation.ts
│   │   │   ├── overlays.ts
│   │   │   ├── panels.ts
│   │   │   ├── policyPage.ts
│   │   │   ├── review.ts
│   │   │   ├── settings.ts
│   │   │   └── shell.ts
│   │   ├── test/
│   │   │   ├── fixtures/
│   │   │   │   └── descriptors.ts
│   │   │   └── harness.ts
│   │   ├── .gitignore
│   │   ├── README.md
│   │   ├── package.json
│   │   ├── themes.css
│   │   └── tsconfig.json
│   ├── values/
│   │   ├── bindings/
│   │   │   ├── generated/
│   │   │   │   ├── BUILD.json
│   │   │   │   ├── values_semantics.d.ts
│   │   │   │   ├── values_semantics.js
│   │   │   │   ├── values_semantics_bg.wasm
│   │   │   │   └── values_semantics_bg.wasm.d.ts
│   │   │   ├── src/
│   │   │   │   ├── exact.rs
│   │   │   │   ├── lib.rs
│   │   │   │   └── validation.rs
│   │   │   ├── Cargo.toml
│   │   │   ├── backend.ts
│   │   │   ├── bootstrap.ts
│   │   │   ├── build.rs
│   │   │   ├── carriers.ts
│   │   │   ├── exact-route.ts
│   │   │   ├── owned-input.ts
│   │   │   ├── plans.ts
│   │   │   ├── serving-validation.ts
│   │   │   └── validation.ts
│   │   ├── conformance/
│   │   │   ├── owned-input/
│   │   │   │   ├── v1/
│   │   │   │   │   ├── README.md
│   │   │   │   │   └── cases.json
│   │   │   │   └── v2/
│   │   │   │       ├── README.md
│   │   │   │       └── cases.json
│   │   │   ├── ports/
│   │   │   │   └── exact/
│   │   │   │       ├── cases.json
│   │   │   │       └── differential.mjs
│   │   │   ├── v1/
│   │   │   │   ├── README.md
│   │   │   │   └── values.json
│   │   │   ├── numeric-text.json
│   │   │   ├── numeric-text.oracle.mjs
│   │   │   ├── string-escape.json
│   │   │   └── string-escape.oracle.mjs
│   │   ├── scripts/
│   │   │   ├── build-semantics.mjs
│   │   │   ├── emit-catalog.mjs
│   │   │   ├── emit-semantics-inputs.mjs
│   │   │   └── stage-semantics.mjs
│   │   ├── semantics/
│   │   │   ├── examples/
│   │   │   │   └── conformance.rs
│   │   │   ├── src/
│   │   │   │   ├── aggregates/
│   │   │   │   │   ├── decimal.rs
│   │   │   │   │   ├── integer.rs
│   │   │   │   │   ├── mod.rs
│   │   │   │   │   ├── money.rs
│   │   │   │   │   └── numeric.rs
│   │   │   │   ├── codecs/
│   │   │   │   │   ├── mod.rs
│   │   │   │   │   └── numeric.rs
│   │   │   │   ├── numeric/
│   │   │   │   │   ├── decimal.rs
│   │   │   │   │   ├── integer.rs
│   │   │   │   │   ├── mod.rs
│   │   │   │   │   ├── money.rs
│   │   │   │   │   └── rounding.rs
│   │   │   │   ├── representations/
│   │   │   │   │   ├── mod.rs
│   │   │   │   │   └── numeric.rs
│   │   │   │   ├── temporal/
│   │   │   │   │   ├── civil.rs
│   │   │   │   │   ├── duration.rs
│   │   │   │   │   ├── instant.rs
│   │   │   │   │   └── mod.rs
│   │   │   │   ├── transport/
│   │   │   │   │   ├── exact.rs
│   │   │   │   │   └── mod.rs
│   │   │   │   ├── currency_facts.rs
│   │   │   │   ├── failures.rs
│   │   │   │   ├── input.rs
│   │   │   │   ├── lib.rs
│   │   │   │   ├── plans.rs
│   │   │   │   ├── profiles.rs
│   │   │   │   └── validation.rs
│   │   │   ├── tests/
│   │   │   │   ├── input_validation/
│   │   │   │   │   ├── conformance_v1.rs
│   │   │   │   │   ├── input.rs
│   │   │   │   │   ├── resolved.rs
│   │   │   │   │   └── validation.rs
│   │   │   │   ├── aggregate_vectors.rs
│   │   │   │   ├── decimal_vectors.rs
│   │   │   │   ├── input_validation.rs
│   │   │   │   ├── integer_vectors.rs
│   │   │   │   ├── money_vectors.rs
│   │   │   │   ├── numeric_text_contract.rs
│   │   │   │   ├── rounding_vectors.rs
│   │   │   │   ├── selected_int_codec.rs
│   │   │   │   ├── string_escape_contract.rs
│   │   │   │   ├── temporal_vectors.rs
│   │   │   │   ├── transport_number_roundtrip.rs
│   │   │   │   └── transport_record_hygiene.rs
│   │   │   ├── Cargo.toml
│   │   │   ├── build.rs
│   │   │   └── currency-facts.json
│   │   ├── src/
│   │   │   ├── internal/
│   │   │   │   ├── gregorian.ts
│   │   │   │   ├── schema-core.ts
│   │   │   │   ├── violations.ts
│   │   │   │   └── wire-core.ts
│   │   │   ├── prepared/
│   │   │   │   ├── codec.ts
│   │   │   │   ├── plan.ts
│   │   │   │   └── validation.ts
│   │   │   ├── array.ts
│   │   │   ├── catalog.ts
│   │   │   ├── currency-data.ts
│   │   │   ├── decimal.ts
│   │   │   ├── distribution.ts
│   │   │   ├── equality.ts
│   │   │   ├── errors.ts
│   │   │   ├── icu-syntax.ts
│   │   │   ├── icu.ts
│   │   │   ├── index.ts
│   │   │   ├── int.ts
│   │   │   ├── kinds.ts
│   │   │   ├── locale.ts
│   │   │   ├── money.ts
│   │   │   ├── schema.ts
│   │   │   ├── stdlib-pure.ts
│   │   │   ├── temporal.ts
│   │   │   ├── text.ts
│   │   │   ├── timezone.ts
│   │   │   ├── types.ts
│   │   │   └── wire.ts
│   │   ├── test/
│   │   │   ├── fixtures/
│   │   │   │   └── icu-profile.json
│   │   │   ├── exact-bootstrap.workerd.mjs
│   │   │   └── round-digits.oracle.ts
│   │   ├── .gitignore
│   │   ├── Cargo.lock
│   │   ├── Cargo.toml
│   │   ├── README.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── work/
│   │   ├── src/
│   │   │   ├── dispatch/
│   │   │   │   ├── durable.ts
│   │   │   │   └── index.ts
│   │   │   ├── event/
│   │   │   │   └── index.ts
│   │   │   ├── intent/
│   │   │   │   ├── index.ts
│   │   │   │   └── staging.ts
│   │   │   ├── kernel/
│   │   │   │   ├── arguments.ts
│   │   │   │   ├── callback-diagnostics.ts
│   │   │   │   ├── commands.ts
│   │   │   │   ├── committed-model-source.ts
│   │   │   │   ├── dispatch-staging.ts
│   │   │   │   ├── file-reference-inventory.ts
│   │   │   │   ├── handler-occurrence.ts
│   │   │   │   ├── occurrence-staging.ts
│   │   │   │   ├── opaque-file-resolver.ts
│   │   │   │   ├── schedule-staging.ts
│   │   │   │   ├── staging-support.ts
│   │   │   │   ├── standard-completion-source.ts
│   │   │   │   └── tables.ts
│   │   │   ├── observation/
│   │   │   │   ├── association.ts
│   │   │   │   ├── observation.ts
│   │   │   │   └── ports.ts
│   │   │   ├── receipt/
│   │   │   │   └── index.ts
│   │   │   ├── recovery/
│   │   │   │   └── index.ts
│   │   │   ├── schedule/
│   │   │   │   ├── every-scope.ts
│   │   │   │   ├── every.ts
│   │   │   │   └── index.ts
│   │   │   ├── catalog.ts
│   │   │   ├── distribution.ts
│   │   │   ├── index.ts
│   │   │   └── ports.ts
│   │   ├── .gitignore
│   │   ├── README.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── work-kernel/
│       ├── bindings/
│       │   ├── host-values.ts
│       │   ├── recovery-planner.ts
│       │   └── work-kernel.ts
│       ├── conformance/
│       │   ├── fixtures/
│       │   │   ├── policy/
│       │   │   │   ├── every.json
│       │   │   │   ├── lifecycle.json
│       │   │   │   └── retry.json
│       │   │   ├── receipts/
│       │   │   │   ├── linkage.json
│       │   │   │   ├── receipt.json
│       │   │   │   └── recovery.json
│       │   │   ├── rows/
│       │   │   │   ├── dispatch.json
│       │   │   │   ├── every_slot.json
│       │   │   │   ├── fanout_checkpoint.json
│       │   │   │   ├── fanout_child.json
│       │   │   │   ├── fanout_intent.json
│       │   │   │   ├── occurrence.json
│       │   │   │   ├── schedule.json
│       │   │   │   └── supersession.json
│       │   │   ├── traces/
│       │   │   │   └── refs.json
│       │   │   └── numeric-text.json
│       │   ├── native-recovery.wasm-test.ts
│       │   ├── numeric-text.oracle.d.mts
│       │   ├── numeric-text.oracle.mjs
│       │   ├── registered-differential.mjs
│       │   └── work-kernel.wasm-test.ts
│       ├── decisions/
│       │   ├── call.rs
│       │   ├── every.rs
│       │   ├── lib.rs
│       │   ├── lifecycle.rs
│       │   ├── linkage.rs
│       │   ├── numeric_text.rs
│       │   ├── receipt.rs
│       │   ├── recovery.rs
│       │   ├── retry.rs
│       │   ├── rows.rs
│       │   ├── uri_component.rs
│       │   └── utf16_json.rs
│       ├── rust/
│       │   ├── lib.rs
│       │   ├── recovery_scan_abi.rs
│       │   └── work_call_abi.rs
│       ├── scripts/
│       │   └── stage-recovery-wasm.mjs
│       ├── src/
│       │   ├── distribution.ts
│       │   ├── every.ts
│       │   ├── facts.ts
│       │   ├── index.ts
│       │   ├── lifecycle.ts
│       │   ├── linkage.ts
│       │   ├── receipt.ts
│       │   ├── recovery.ts
│       │   ├── retry.ts
│       │   └── rows.ts
│       ├── tests/
│       │   ├── native-numeric-text.rs
│       │   ├── numeric_text_corpus.rs
│       │   └── registered_conformance.rs
│       ├── Cargo.lock
│       ├── Cargo.toml
│       ├── README.md
│       ├── build.rs
│       ├── package.json
│       └── tsconfig.json
├── scripts/
│   ├── distribution/
│   │   ├── browser/
│   │   │   ├── bun.lock
│   │   │   └── package.json
│   │   ├── licenses/
│   │   │   ├── Miniflare-D1-LICENSE
│   │   │   ├── sharp-libvips-LICENSE
│   │   │   └── workerd-LICENSE
│   │   ├── browser-tools.mjs
│   │   ├── bun-LICENSE.md
│   │   ├── bun.lock
│   │   ├── module-resolution.mjs
│   │   ├── native-artifact.mjs
│   │   └── package.json
│   ├── fixtures/
│   │   ├── native-runtime.can
│   │   ├── preview-persistence.can
│   │   └── soda-runtime.can
│   ├── build-install.mjs
│   ├── build-package.mjs
│   ├── capture-dev-frontend.mjs
│   ├── capture.mjs
│   ├── check-compiler-release-notices.py
│   ├── check-dev-server-release-notices.py
│   ├── check-no-unit-tests.sh
│   ├── check-package-boundaries.mjs
│   ├── check-ts-unitban.ts
│   ├── install-browser-tools.sh
│   ├── install.sh
│   ├── pack-install.mjs
│   ├── pack-release.mjs
│   ├── pack-soda-runtime.mjs
│   ├── pack-tools.mjs
│   ├── publish-install-release.mjs
│   ├── run-tasks.mjs
│   ├── verify-install.mjs
│   ├── verify-installed-dev-server.mjs
│   ├── verify-installed-lsp.mjs
│   ├── verify-installed-startup.mjs
│   ├── verify-installed-types.mjs
│   ├── verify-installed-worker.mjs
│   ├── verify-native-runtime.mjs
│   ├── verify-preview-persistence.mjs
│   ├── verify-soda-direct.mjs
│   ├── verify-soda-host.mjs
│   ├── verify-soda-recovery.mjs
│   ├── verify-soda-runtime-closure.mjs
│   └── verify-soda-runtime.mjs
├── tests/
│   ├── e2e/
│   │   ├── apps/
│   │   │   ├── challenge-pilot-patched.spec.ts
│   │   │   ├── challenge-pilot.spec.ts
│   │   │   ├── compiled-identity.spec.ts
│   │   │   ├── compiled-journey.spec.ts
│   │   │   ├── pilot-legs.ts
│   │   │   ├── scaffold.spec.ts
│   │   │   ├── teamtasks-mcp.spec.ts
│   │   │   ├── teamtasks-update.spec.ts
│   │   │   └── teamtasks.spec.ts
│   │   ├── bridges/
│   │   │   ├── http-bridge.ts
│   │   │   └── mcp-bridge.ts
│   │   ├── drafts/
│   │   │   ├── config.ts
│   │   │   ├── dev-session.ts
│   │   │   ├── source.ts
│   │   │   ├── suite.ts
│   │   │   ├── tsconfig.json
│   │   │   └── visual.ts
│   │   ├── fixtures/
│   │   │   ├── handbuilt/
│   │   │   │   ├── identity-bundle-entry.js
│   │   │   │   ├── mcp-bundle-entry.js
│   │   │   │   ├── teamtasks-worker.mjs
│   │   │   │   ├── teamtasks.ts
│   │   │   │   └── ui-bundle-entry.js
│   │   │   ├── patched-pilot/
│   │   │   │   ├── CanDo.can
│   │   │   │   ├── Employees.can
│   │   │   │   ├── Locations.can
│   │   │   │   └── README.md
│   │   │   ├── artifact-loader.ts
│   │   │   ├── cando-seed.spec.ts
│   │   │   ├── cando-seed.ts
│   │   │   ├── compiled-seed.ts
│   │   │   ├── compiled-shop.can
│   │   │   ├── e2e-test.ts
│   │   │   ├── example-hooks.ts
│   │   │   ├── mcp-grants.ts
│   │   │   ├── pilot-examples.spec.ts
│   │   │   ├── pilot-examples.ts
│   │   │   ├── pilot-seed.ts
│   │   │   ├── seed.ts
│   │   │   ├── vendor-trees.ts
│   │   │   └── vendor-walk.spec.ts
│   │   └── tsconfig.json
│   ├── fixtures/
│   │   ├── action-forms/
│   │   │   ├── playwright/
│   │   │   │   └── app.spec.ts
│   │   │   ├── ActionForms.can
│   │   │   ├── README.md
│   │   │   └── playwright.config.ts
│   │   ├── action-gallery/
│   │   │   ├── playwright/
│   │   │   │   └── app.spec.ts
│   │   │   ├── ActionGallery.can
│   │   │   ├── README.md
│   │   │   └── playwright.config.ts
│   │   ├── prompt-pipeline/
│   │   │   ├── can.generated/
│   │   │   │   ├── u1/
│   │   │   │   │   ├── contributions.can
│   │   │   │   │   └── unit.json
│   │   │   │   ├── u2/
│   │   │   │   │   ├── contributions.can
│   │   │   │   │   └── unit.json
│   │   │   │   ├── u3/
│   │   │   │   │   ├── implementation.js
│   │   │   │   │   └── unit.json
│   │   │   │   ├── u4/
│   │   │   │   │   ├── contributions.can
│   │   │   │   │   └── unit.json
│   │   │   │   ├── u5/
│   │   │   │   │   ├── contributions.can
│   │   │   │   │   └── unit.json
│   │   │   │   ├── u6/
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   ├── u7/
│   │   │   │   │   ├── implementation.js
│   │   │   │   │   ├── style.css
│   │   │   │   │   └── unit.json
│   │   │   │   └── u8/
│   │   │   │       ├── style.css
│   │   │   │       └── unit.json
│   │   │   ├── playwright/
│   │   │   │   └── app.spec.ts
│   │   │   ├── PromptStudio.can
│   │   │   ├── README.md
│   │   │   ├── can.gen.toml
│   │   │   ├── playwright.config.ts
│   │   │   └── verify-acceptance.mjs
│   │   ├── playwright.fixture-config.ts
│   │   └── raw-worker.ts
│   └── integration/
│       ├── can-dev-server/
│       │   ├── ACCEPTANCE.md
│       │   ├── AppOwnedPreview.can
│       │   ├── ModelFreePreview.can
│       │   ├── NativeLocalRules.can
│       │   ├── NativeRefArrays.can
│       │   ├── NativeSavedScenario.can
│       │   ├── NativeStaticCalls.can
│       │   ├── OfficeSupplies.can
│       │   └── row-subject-consumer.test.ts
│       ├── README.md
│       ├── b1-team-tasks.md
│       ├── b2-d1-fence.test.ts
│       ├── b2-delivery.test.ts
│       ├── b2-do-local.test.ts
│       ├── b2-revocation.test.ts
│       ├── files-safety.test.ts
│       ├── identity-auth.test.ts
│       ├── lane02-values.test.ts
│       ├── readiness.test.ts
│       ├── stdlib-builtins.test.ts
│       ├── work-idempotency.test.ts
│       └── work-kernel-decisions.test.ts
├── tools/
│   ├── unitban/
│   │   ├── allow-runner-imports.txt
│   │   ├── allow-ts.txt
│   │   └── build_impl.rs
│   ├── README.md
│   ├── b3-s4-demo.sh
│   ├── can_parser.py
│   └── jev.py
├── .gitignore
├── .gitmodules
├── .vitest-pending.config.ts
├── AGENTS.md
├── LICENSE
├── README.md
├── bun.lock
├── bunfig.toml
├── package.json
├── playwright.config.ts
├── playwright.drafts.config.ts
├── playwright.prompts.config.ts
├── tasks.can
├── tsconfig.base.json
├── tsconfig.check.json
├── turbo.json
└── vitest.config.ts
```
