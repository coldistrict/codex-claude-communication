import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface PickerCommand {
  command: string;
  args: string[];
  cancelExitCodes: number[];
  cancelStderrPattern?: RegExp;
}

type PickerCommandResult =
  | { kind: "selected"; path: string }
  | { kind: "cancelled" }
  | { kind: "unavailable" };

function pickerCommands(platform: NodeJS.Platform): PickerCommand[] {
  if (platform === "darwin") {
    return [
      {
        command: "/usr/bin/osascript",
        args: [
          "-e",
          'POSIX path of (choose folder with prompt "Choose a project or workspace")',
        ],
        cancelExitCodes: [1],
        cancelStderrPattern: /-128\b/,
      },
    ];
  }

  if (platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = 'Choose a project or workspace'",
      "$dialog.ShowNewFolderButton = $true",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
      "  [Console]::Out.Write($dialog.SelectedPath)",
      "} else {",
      "  exit 2",
      "}",
    ].join("\n");
    return [
      {
        command: "powershell.exe",
        args: ["-NoProfile", "-STA", "-Command", script],
        cancelExitCodes: [2],
      },
      {
        command: "pwsh.exe",
        args: ["-NoProfile", "-STA", "-Command", script],
        cancelExitCodes: [2],
      },
    ];
  }

  if (platform === "linux") {
    return [
      {
        command: "zenity",
        args: [
          "--file-selection",
          "--directory",
          "--title=Choose a project or workspace",
        ],
        cancelExitCodes: [1],
      },
      {
        command: "kdialog",
        args: ["--title", "Choose a project or workspace", "--getexistingdirectory", "."],
        cancelExitCodes: [1],
      },
    ];
  }

  return [];
}

function exitCode(error: unknown): number | string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" || typeof code === "string" ? code : undefined;
}

async function runPickerCommand(spec: PickerCommand): Promise<PickerCommandResult> {
  try {
    const { stdout } = await execFileAsync(spec.command, spec.args, {
      encoding: "utf8",
      timeout: 24 * 60 * 60 * 1_000,
      maxBuffer: 64 * 1024,
      windowsHide: false,
    });
    const path = String(stdout).replace(/\r?\n$/, "");
    return path ? { kind: "selected", path } : { kind: "cancelled" };
  } catch (error) {
    const code = exitCode(error);
    if (code === "ENOENT") return { kind: "unavailable" };
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "")
        : "";
    if (
      typeof code === "number" &&
      spec.cancelExitCodes.includes(code) &&
      (!spec.cancelStderrPattern || spec.cancelStderrPattern.test(stderr))
    ) {
      return { kind: "cancelled" };
    }
    throw new Error("DIRECTORY_PICKER_FAILED");
  }
}

/**
 * Opens the host operating system's folder chooser and returns the selected
 * absolute path. The local HTTP service calls this only after session, origin,
 * and CSRF validation; no request data is interpolated into native commands.
 */
export async function pickNativeDirectory(
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const commands = pickerCommands(platform);
  if (!commands.length) throw new Error("DIRECTORY_PICKER_UNSUPPORTED_PLATFORM");

  for (const command of commands) {
    const result = await runPickerCommand(command);
    if (result.kind === "selected") return result.path;
    if (result.kind === "cancelled") return null;
  }

  throw new Error("DIRECTORY_PICKER_UNAVAILABLE");
}
