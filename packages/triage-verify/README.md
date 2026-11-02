# @corbits/triage-verify

Checks a policy file the way Corbits Triage reads it.

```
Usage: triage-verify [--owner <owner>] [--name <name>] <policy-file>

Checks a policy file the way Corbits Triage reads it.
`extends` is not resolved: a parent policy is not loaded.
--owner and --name are optional and must be passed together.
When they are omitted, the file is read as owner/name.
```

```sh
npx @corbits/triage-verify .corbits-triage.yml
```

`--owner` and `--name` are optional and must be passed together. When they are omitted, the file is read as owner/name.

A missing path, a path that is not a file, or a file Triage would refuse exits non-zero. When the file is accepted and a block is still pending, each reason is a warning and the command exits 0.

`extends` is not resolved: a parent policy is not loaded.
