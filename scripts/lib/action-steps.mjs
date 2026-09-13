// Reads one composite step out of action.yml: its `run:` script, its `env:`
// mapping, and its `working-directory:`.
//
// WHY THIS IS SHARED RATHER THAN COPIED. Two callers execute action.yml's own
// step scripts: scripts/tests/action-run-script.test.mjs, which runs them
// against stubbed npm, and bench/action-install.mjs, which runs them against
// real npm and a local registry. A second copy of this parser would drift, and
// the drift would be invisible: both callers would keep passing, each against
// its own idea of what the file says.
//
// DERIVED, NEVER ASSUMED. A harness with its own table of environment
// variables, or its own idea of a step's working directory, asserts a property
// of the harness. A review deleted the entire install step from a copy of
// action.yml and every test still passed; removing `working-directory` from a
// step passed too. Everything a caller needs about a step comes from the file.
//
// This is a parser for the subset action.yml actually uses, not a YAML
// implementation. It handles the shapes below and returns the rest as-is.

import { readFileSync } from 'node:fs';

// A trailing `# comment` is not part of a scalar's value, and a quoted scalar
// is not quoted once YAML has read it.
//
// Both cases were found by a review feeding this parser legal YAML the real
// file does not currently use. Keeping the comment flowed it into the scan
// argument, so the suite tested a command GitHub would never issue. Keeping
// the quotes turns a CORRECT action.yml red, which invites the next person to
// loosen the assertion instead of fixing the parser.
//
// A later review found a third case, which is the first two TOGETHER: the
// quote check returned early, so a quoted value carrying a trailing comment
// kept its quotes. The comment is stripped first and then the quotes, so
// neither order matters.
export function normaliseScalar(raw) {
  let value = raw.trim();
  // A `#` only starts a comment when whitespace precedes it, so `a#b` is a
  // value. Skipped entirely inside a quoted scalar, where `#` is literal.
  if (!/^['"]/.test(value)) {
    const comment = /\s+#.*$/.exec(value);
    if (comment) value = value.slice(0, comment.index).trim();
  } else {
    const closing = /^(['"])(.*)\1(\s+#.*)?$/.exec(value);
    if (closing) return closing[2];
  }
  const quoted = /^(['"])(.*)\1$/.exec(value);
  if (quoted) return quoted[2];
  return value;
}

// Binds the parser to one action.yml. `loadAction(path)` rather than a module
// constant so a caller can point it at another revision of the file: the
// suite uses DG_ACTION_FILE to run against a deliberately weakened copy, and
// the dogfood harness uses it to run the PRE-FIX action from a tag and watch
// the attack land.
export function loadAction(actionPath) {
  const actionYml = readFileSync(actionPath, 'utf8');
  const lines = actionYml.split('\n');

  function stepIndex(stepName) {
    return lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  }

  function hasStep(stepName) {
    return stepIndex(stepName) !== -1;
  }

  function requireStep(stepName) {
    const at = stepIndex(stepName);
    if (at === -1) {
      throw new Error(`no step named ${stepName} in ${actionPath}`);
    }
    return at;
  }

  // Pulls one step's `run:` block out of action.yml by step name, keeping the
  // real file the single source of truth. A copy of the script pasted into a
  // test would pass forever after action.yml drifted away from it, which is
  // the exact failure mode the textual guards in
  // scripts/tests/action-path-validation.test.mjs exist to prevent.
  function extractRunScript(stepName) {
    const stepAt = requireStep(stepName);
    const runAt = lines.findIndex((l, i) => i > stepAt && l.trim() === 'run: |');
    if (runAt === -1) {
      throw new Error(`step ${stepName} has no "run: |" block`);
    }
    const indent = lines[runAt].length - lines[runAt].trimStart().length + 2;
    const body = [];
    for (let i = runAt + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim().length === 0) {
        body.push('');
        continue;
      }
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent < indent) {
        break;
      }
      body.push(line.slice(indent));
    }
    return body.join('\n');
  }

  // The step's own `env:` mapping, as declared in action.yml.
  //
  // EVERY VARIABLE A CALLER SUPPLIES COMES FROM HERE, never from a table
  // written in the caller. A harness that injects a variable the step does not
  // declare is testing a program that does not exist: on a real runner the
  // script would see that value empty, and the suite would stay green while
  // the action quietly stopped reading one of its own inputs.
  function extractStepEnv(stepName) {
    const stepAt = requireStep(stepName);
    const envAt = lines.findIndex((l, i) => i > stepAt && l.trim() === 'env:');
    if (envAt === -1 || envAt > lines.findIndex((l, i) => i > stepAt && l.trim() === 'run: |')) {
      throw new Error(`step ${stepName} has no env: block before its run: block`);
    }
    const indent = lines[envAt].length - lines[envAt].trimStart().length + 2;
    const env = {};
    for (let i = envAt + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim().length === 0) continue;
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent < indent) break;
      if (lineIndent > indent || line.trim().startsWith('#')) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line.trim());
      if (match) env[match[1]] = normaliseScalar(match[2]);
    }
    return env;
  }

  // The step's declared working directory, or '' when it declares none.
  //
  // YAML mappings are unordered and GitHub honours `working-directory`
  // wherever it sits in the step, so this scans the WHOLE step rather than
  // stopping at `run: |`. Stopping there was a real miss: moving the key below
  // the run block is behaviour-identical and used to turn the suite red.
  //
  // The run block's own body is skipped by indentation, because a script line
  // could say `working-directory:` in a comment and must not be read as the
  // step's.
  function extractStepWorkingDirectory(stepName) {
    const stepAt = requireStep(stepName);
    const keyIndent = lines[stepAt].indexOf('- name:') + 2;
    for (let i = stepAt + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim().length === 0) continue;
      const indent = line.length - line.trimStart().length;
      // Dedented to or past the step marker: the next step, or the end.
      if (indent < keyIndent) break;
      // Deeper than the step's own keys: a run body or an env mapping.
      if (indent > keyIndent) continue;
      const match = /^working-directory:\s*(.*)$/.exec(line.trim());
      if (match) return normaliseScalar(match[1]);
    }
    return '';
  }

  // The `${{ }}` expressions this action uses, and nothing else. Throwing on
  // an unmodelled one is deliberate: a step that started reading a context the
  // caller does not know about would otherwise be run with that value blank.
  function evaluateTemplate(template, ctx) {
    return template.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_m, raw) => {
      const expression = raw.trim();
      if (expression.startsWith('inputs.')) {
        const name = expression.slice('inputs.'.length);
        if (!(name in ctx.inputs)) {
          throw new Error(`${actionPath} reads inputs.${name}, which the caller did not set`);
        }
        return ctx.inputs[name];
      }
      if (expression === 'runner.temp') return ctx.runnerTemp;
      throw new Error(`the harness cannot evaluate the expression ${expression}`);
    });
  }

  function evaluateStepEnv(stepName, ctx) {
    const templates = extractStepEnv(stepName);
    const env = {};
    for (const [key, template] of Object.entries(templates)) {
      env[key] = evaluateTemplate(template, ctx);
    }
    return env;
  }

  function cwdForStep(stepName, ctx) {
    const declared = extractStepWorkingDirectory(stepName);
    // No working-directory means the workspace root, which is the head's own
    // tree. The default has to be the unsafe one: a caller that defaulted
    // somewhere safe would report a step as isolated that is not.
    return declared ? evaluateTemplate(declared, ctx) : ctx.workspace;
  }

  return {
    actionPath,
    text: actionYml,
    hasStep,
    extractRunScript,
    extractStepEnv,
    extractStepWorkingDirectory,
    evaluateTemplate,
    evaluateStepEnv,
    cwdForStep,
  };
}
