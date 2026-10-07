import pathlib, subprocess, json, datetime
out=pathlib.Path('/Users/vince/Projects/canlang/docs/research/compiler-library-audit-20261006/pass9/profile')
image='rust@sha256:24e632c09342c20abf8312cf4f61430a911c01ed3a5e4c02b87292b1c39c5273'
command=['docker','run','--rm','--pull=never','--platform','linux/amd64','--network','none','-e','CARGO_HOME=/cargo-home','-e','CARGO_BUILD_JOBS=1','-e','CARGO_INCREMENTAL=0','-v','/private/tmp/canlang-pass9-profile:/profile:ro','-v','/private/tmp/canlang-pass5-profile/cargo-home:/cargo-home','-v','/private/tmp/canlang-pass5-profile/current-linux-target:/linux-target',image,'sh','/profile/linux-tests.sh']
started=datetime.datetime.now(datetime.timezone.utc).isoformat()
(out/'commands.json').write_text(json.dumps({'linux':command,'script':'linux-tests.sh','started_at':started},indent=2)+'\n')
with (out/'linux-tests.log').open('w') as log:
    process=subprocess.Popen(command,stdout=log,stderr=subprocess.STDOUT)
    code=process.wait()
(out/'linux-exit.json').write_text(json.dumps({'exit_code':code,'started_at':started,'completed_at':datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=2)+'\n')
print('Linux container exit:',code)
raise SystemExit(code)
