# Install CanLang and write an app

Install the complete CanLang toolchain with one command, create a task application in your own folder, and check its source before adding more behavior.

## The tools you will use

The standalone bundle supplies `can`, its matching language catalog, private Node runtime, runtime adapters, local Worker engine and inline-example tools. It runs independently of Soda OS. You do not need to install Rust, Node, Bun, npm packages or a browser separately. Local checking, testing and preview need no Cloudflare account.

## Install the standalone bundle

Run this command in a terminal:

```sh
curl -fsSL https://sodaos.dev/CanLang/install.sh | bash
```

The installer detects macOS Apple Silicon or Linux x86-64 with glibc, resolves one GitHub release version, and downloads that platform's matching archive and SHA-256 checksum. The published v0.1.1 Linux bundle requires glibc 2.39 or newer. Both platform bundles belong to the same release; there are no separate version tracks to choose.

The installer verifies the checksum, installs under `~/.can`, and configures your shell PATH. Open a new terminal, then confirm the installation:

```sh
can --version
```

You can now write and run the tutorial in an application directory of your choice. No CanLang source checkout, catalog build or runtime environment overrides are needed.

## Create Tasks

Create a folder for your application:

```sh
mkdir canlang-tasks
cd canlang-tasks
```

Save this complete application as `Tasks.can` in that folder. Each indentation level is exactly one space.

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

An optional Can extension supports VS Code 1.91 or newer and compatible editors such as Cursor. It supplies highlighting, diagnostics, completion, navigation and formatting. If you are installing a separately supplied `canlang-vscode.vsix`, open Extensions, choose **Install from VSIX**, select the file and reload the window. The shell installer and every terminal step in this tutorial work without an editor extension; building the extension belongs to contributor setup.

Syntax highlighting works without the compiler. For diagnostics and navigation, set the extension's `can.serverPath` to the absolute path of your installed `~/.can/bin/can` if it is not on the editor's PATH. Expand `~` to your home directory when entering an absolute editor setting. Trust the workspace to enable language tools. Use **Can: Restart Language Server** after changing the toolchain. An editor extension is optional for every terminal step in this tutorial.

## Optional browser development tools

Chrome, Chromium and Playwright are separate, optional development tools. Ordinary source checks, inline examples and local previews work without them. If you author browser automation or require browser acceptance, follow the [browser development tools instructions](https://github.com/veighnsche/canlang/blob/main/docs/install.md#optional-browser-development-tools). The add-on lives outside the core installation; a required browser check reports missing tooling rather than silently skipping it.

## Optional contributor setup

### Set up a complete source workspace

Only contributors changing CanLang's compiler or runtime need a source build. Follow [optional contributor setup](03-contributor-setup.md) for the repository, build prerequisites, catalog generation and runtime overrides. Building CanLang is not a prerequisite for writing, checking, testing or previewing an application.
