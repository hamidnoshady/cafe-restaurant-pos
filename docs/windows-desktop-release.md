# Windows desktop releases

The Windows installer is built on a **self-hosted Windows runner**, not on a
GitHub-hosted machine. Publishing is manual so a release is created only when
someone deliberately starts it.

## One-time self-hosted runner setup

In GitHub, open **Settings → Actions → Runners → New self-hosted runner** for
this repository. Add a Windows x64 runner and give it the labels:

- `self-hosted`
- `windows`
- `x64`

The runner machine needs Node.js 20, Git, npm, internet access to npm and
GitHub, and enough free disk space for the Next.js build and Electron cache.
Keep the runner online when a release is started. It should run as a dedicated
build account and must not be used for untrusted pull requests.

The workflow uses the automatically provided `GITHUB_TOKEN`; no personal token
or signing secret is required for an unsigned installer.

## Publish an update

1. Push the application changes to the branch or tag that should be released.
2. In GitHub, open **Actions → Windows desktop release → Run workflow**.
3. Select that ref and enter the desktop version, such as `1.0.6` (do not add
   the `v` prefix).
4. Leave **pre-release** off for a normal update, then click **Run workflow**.
5. The runner installs dependencies, builds the web app, builds the NSIS
   installer, and creates or updates **GitHub → Releases → Business Suite
   v1.0.6**.

The release contains the `.exe` installer plus Electron's update metadata and
blockmap files. The same files are also retained as workflow artifacts for 30
days. Running the workflow again with the same version updates that GitHub
Release; use a new version for a new customer-facing update.

The version is applied to `electron/package.json` only in the runner's
workspace. The workflow does not commit or push generated version changes.

## If a run cannot start

A queued run normally means no online runner currently has all three required
labels. Check **Settings → Actions → Runners** and start the runner service.
If the build fails while extracting `winCodeSign`, run the workflow again after
ensuring the runner account has a writable Electron Builder cache and that the
repository's `electron/scripts/prepare-wincodesign-cache.js` can reach GitHub.
