import type { Command } from "commander";
import { fail } from "../ui.js";

/** Visible command names + aliases of the program. */
function commandNames(program: Command): string[] {
  const names: string[] = [];
  for (const cmd of program.commands) {
    // Hidden commands (hook-capture) are internal — leave them out.
    if ((cmd as unknown as { _hidden?: boolean })._hidden) continue;
    names.push(cmd.name(), ...cmd.aliases());
  }
  return names;
}

/** Long flags of one subcommand. */
function flagsOf(program: Command, name: string): string[] {
  const cmd = program.commands.find((c) => c.name() === name);
  if (!cmd) return [];
  return cmd.options.map((o) => o.long).filter((f): f is string => Boolean(f));
}

function bashScript(program: Command): string {
  const cmds = commandNames(program).join(" ");
  const cases = commandNames(program)
    .map((c) => `    ${c}) opts="${flagsOf(program, c).join(" ")}" ;;`)
    .join("\n");
  return `# bash completion for cc-skill-trace (#100)
# Install: cc-skill-trace completion bash >> ~/.bashrc  (or /etc/bash_completion.d/)
_cc_skill_trace() {
  local cur prev cmds opts
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cmds="${cmds}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$cmds" -- "$cur") )
    return 0
  fi
  case "\${COMP_WORDS[1]}" in
${cases}
    *) opts="" ;;
  esac
  COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
}
complete -F _cc_skill_trace cc-skill-trace
`;
}

function zshScript(program: Command): string {
  const cmds = commandNames(program).join(" ");
  const cases = commandNames(program)
    .map(
      (c) =>
        `    ${c}) _values 'options' ${
          flagsOf(program, c)
            .map((f) => `'${f}'`)
            .join(" ") || "''"
        } ;;`
    )
    .join("\n");
  return `#compdef cc-skill-trace
# zsh completion for cc-skill-trace (#100)
# Install: cc-skill-trace completion zsh > "\${fpath[1]}/_cc-skill-trace"
_cc_skill_trace() {
  if (( CURRENT == 2 )); then
    _values 'command' ${cmds
      .split(" ")
      .map((c) => `'${c}'`)
      .join(" ")}
    return
  fi
  case "$words[2]" in
${cases}
  esac
}
_cc_skill_trace "$@"
`;
}

function fishScript(program: Command): string {
  const lines = [
    `# fish completion for cc-skill-trace (#100)`,
    `# Install: cc-skill-trace completion fish > ~/.config/fish/completions/cc-skill-trace.fish`,
  ];
  for (const name of commandNames(program)) {
    lines.push(`complete -c cc-skill-trace -n "__fish_use_subcommand" -a "${name}"`);
    for (const flag of flagsOf(program, name)) {
      lines.push(
        `complete -c cc-skill-trace -n "__fish_seen_subcommand_from ${name}" -l "${flag.replace(/^--/, "")}"`
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function registerCompletionCommand(program: Command): void {
  program
    .command("completion <shell>")
    .description("Print a shell completion script: bash | zsh | fish (#100)")
    .action((shell: string) => {
      const s = shell.toLowerCase();
      if (s === "bash") process.stdout.write(bashScript(program));
      else if (s === "zsh") process.stdout.write(zshScript(program));
      else if (s === "fish") process.stdout.write(fishScript(program));
      else fail(`Unsupported shell "${shell}". Use bash, zsh or fish.`);
    });
}
