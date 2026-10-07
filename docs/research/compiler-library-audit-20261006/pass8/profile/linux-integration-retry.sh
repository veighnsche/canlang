set -eu
if command -v node; then node -v; else echo 'Node unavailable in pinned Rust image'; fi
cargo test --offline --locked --manifest-path /profile/current/compiler/Cargo.toml --target-dir /linux-target --test codegen -- --skip b4g_hook_team_operation_unchanged --skip b4g_operation_id_lowers_through_c --skip b4g_team_id_lowers_through_c --skip t21l1_single_app_crud_entry_imports_and_executes --skip t31_hook_delete_op_registry --skip t31_plain_schedule_lowers --skip t31_hook_run_shape --skip t31_e2e_staged_failure_names_hook --skip t31_e2e_emitted_hook_drives_engine --nocapture
cargo test --offline --locked --manifest-path /profile/current/compiler/Cargo.toml --target-dir /linux-target --test typed_artifact -- --nocapture
