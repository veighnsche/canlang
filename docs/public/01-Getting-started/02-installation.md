# Install CanLang and write an app

Set up the `can` compiler, create a complete task application, and check its source before adding more behavior.

## The tools you will use

The compiler is a single `can` binary. Compiler commands such as `check`, `fmt` and `policy` use it directly; platform commands also need the matching `can-platform` runtime, and local development needs `can-dev`. Build the source workspace below to obtain those tools and the language catalog together.

## Set up a complete source workspace

Use this route to get the compiler, catalog, runtime packages and examples together. Prerequisites are Bun 1.4.2, Node.js 22 or newer and Rust 1.99.0. Node 24 is the verified runtime test profile. Local build and development do not need a Cloudflare account.

```sh
git clone --recurse-submodules https://github.com/veighnsche/canlang.git
cd canlang
bun install --frozen-lockfile
bun run build
bun run catalog
bun run build:compiler
export PATH="$PWD/compiler/target/debug:$PWD/node_modules/.bin:$PATH"
export CAN_PLATFORM_BIN="$PWD/packages/cloudflare/dist/cli/platform.js"
export CAN_DEV_BIN="$PWD/packages/cloudflare/dist/dev/control-cli.js"
can --version
```

Run the following tutorial from that repository root so the compiler can discover `packages/values/dist/catalog.json`. In another directory, pass an absolute `--catalog=PATH` to compiler commands or set `CAN_CATALOG`. Keep absolute runtime overrides when changing directories.

## Create Tasks

Save this complete application as `Tasks.can` in the repository root. Each indentation level is exactly one space.

```can
# Track the team's work.
app Tasks
Given
 export Todo { title:text trim, done:bool=false }
 policy Todo read=members
When
 crud Todo by=members fields=title,done
Then
 page / title="Tasks"
  form Todo.create display=inline
  list Todo
   edit
   delete
```

`Todo` is a stored record type. `trim` normalizes its title and `done` defaults to false. The read policy permits team members to see records. `crud` enables canonical create, update and delete with the declared input fields. The page binds its form and row controls to those operations.

## Check and inspect it

```sh
can check Tasks.can
can fmt --check Tasks.can
can policy Tasks.can
can compile --format=json Tasks.can
```

`check` validates names, types and rules. `fmt --check` reports formatting differences without writing; run `can fmt Tasks.can` to apply canonical formatting. `policy` makes the declared authority surface reviewable. `compile` additionally checks emission and prints the artifact envelope. A successful source check and a successful compile answer different questions.

Next, follow [local development](../03-Build-and-operate/01-local-development.md) for a protected preview. Add [behavior examples](../03-Build-and-operate/02-testing.md) before growing the workflow.

## Editor integration

The Can extension supports VS Code 1.91 or newer and compatible editors such as Cursor. It supplies highlighting, diagnostics, completion, navigation and formatting. When you have a built `canlang-vscode.vsix`, open Extensions, choose **Install from VSIX**, select that file and reload the window. Source and build ownership for the extension lives in `editors/vscode` in this checkout.

Syntax highlighting works without the compiler. For diagnostics and navigation, set the extension's `can.serverPath` to the absolute path of the `compiler/target/debug/can` executable you just built if it is not on the editor's PATH. Trust the workspace to enable language tools. Use **Can: Restart Language Server** after changing the producer catalog. An editor extension is optional for every terminal step in this tutorial.
