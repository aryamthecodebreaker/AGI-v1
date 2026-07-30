# Workflows

A workflow is a saved, reusable sequence of device actions — "start study mode",
"prepare my FixMap workspace".

A workflow is **not a script**. Every step is a validated capability, its
parameters, and a target expression. There is no code field and nothing is
evaluated, so a workflow can only ever do what a one-off command could already
do, through the same registry, policy and execution tracking.

---

## Anatomy

```json
{
  "name": "Study Mode",
  "description": "Notes on the laptop, timer on the phone",
  "steps": [
    {
      "capability": "app.open",
      "parameters": { "appId": "notion" },
      "targetExpression": { "includeDeviceNames": ["Laptop"] },
      "mode": "sequential",
      "onFailure": "stop"
    },
    {
      "capability": "notification.show",
      "parameters": { "title": "Study timer started" },
      "targetExpression": { "includeDeviceNames": ["Phone One"] }
    },
    {
      "capability": "volume.mute",
      "parameters": {},
      "targetExpression": { "includeDeviceNames": ["Tablet"] },
      "onFailure": "continue"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `capability` | Must exist in the registry. Prohibited names are refused. |
| `parameters` | Validated against that capability's input schema at save time |
| `targetExpression` | The same target grammar the resolver uses everywhere |
| `mode` | `sequential` (default) or `parallel` |
| `onFailure` | `stop` (default) or `continue` |
| `timeoutMs` | Optional per-step override |

Validation happens **when you save**, so a stored workflow is always inspectable
and runnable. A workflow with an unknown capability, bad parameters, or no target
is rejected with a message naming the step.

Limits: 25 steps per workflow.

---

## Sequential and parallel

Consecutive steps marked `parallel` form one batch and run together. A
`sequential` step stands alone and waits.

```
step 1  sequential   ──▶ runs, waits
step 2  parallel     ──┐
step 3  parallel     ──┴▶ run together, wait for both
step 4  sequential   ──▶ runs, waits
```

Within a single step, dispatch to multiple devices is always concurrent —
`mode` is about steps, not devices.

---

## Confirmation

A workflow run asks **once**, up front, showing every step and its resolved
targets:

```
Before I run "Study Mode":
1. open notion on Laptop
2. show a notification titled "Study timer started" on Phone One
3. mute on Tablet

Should I go ahead?
```

Once confirmed, the steps run without asking again. Asking per step would make a
four-step routine unusable, and you have already seen exactly what will happen.

The confirmation is bound to a fingerprint over every step. **If the workflow is
edited between being described and being confirmed, the confirmation stops
applying** and you are told why — so an edit cannot smuggle a different action
past a "yes" you gave to something else.

Confirmations are single-use and expire after two minutes.

---

## Failure handling

`onFailure: "stop"` ends the run. Remaining steps are reported as `skipped` —
listed explicitly, not silently dropped:

```
"Fragile" stopped early:
1. app.open — failed (Laptop: failed)
2. notification.show — skipped
```

`onFailure: "continue"` carries on. Each step reports its own per-device results.

---

## Running one

**From the UI:** Flows panel → **Run**. Confirm the card.

**Conversationally:** "start study mode", "prepare my FixMap workspace". The
planner matches the name against your saved workflows and returns the same
confirmation.

**Over HTTP:**

```bash
# Returns a runId and a confirmation. Nothing is dispatched yet.
curl -X POST /api/workflows/$ID/run -b cookies.txt

# Answer it.
curl -X POST /api/workflows/runs/$RUN_ID/confirm \
     -H 'Content-Type: application/json' -d '{"confirm":true}' -b cookies.txt

# Inspect the commands the run created.
curl /api/workflows/runs/$RUN_ID -b cookies.txt
```

Every step creates an ordinary command carrying the `workflowRunId`, so a run's
history is visible in the normal command list.

---

## Examples

### FixMap workspace

```json
{
  "name": "FixMap Workspace",
  "steps": [
    { "capability": "url.open", "parameters": { "url": "https://github.com/aryamthecodebreaker/FixMap" },
      "targetExpression": { "includeDeviceNames": ["Laptop"] }, "mode": "parallel" },
    { "capability": "app.open", "parameters": { "appId": "vscode" },
      "targetExpression": { "includeDeviceNames": ["Laptop"] }, "mode": "parallel" },
    { "capability": "notification.show", "parameters": { "title": "FixMap workspace ready" },
      "targetExpression": { "primaryOnly": true } }
  ]
}
```

### Amy workspace

```json
{
  "name": "Amy Workspace",
  "steps": [
    { "capability": "url.open", "parameters": { "url": "https://github.com/aryamthecodebreaker/Amy" },
      "targetExpression": { "includeDeviceNames": ["Laptop"] } },
    { "capability": "app.open", "parameters": { "appId": "vscode" },
      "targetExpression": { "includeDeviceNames": ["Laptop"] } }
  ]
}
```

---

## Limits, on purpose

- No conditionals, loops or variables. A workflow that can branch is a program,
  and a program that a model can write is the thing this design avoids.
- No shell, no scripts, no downloaded code.
- No capability that is not already exposed to a single command.
- The assistant may help you draft or edit a workflow, but the saved result is
  always explicit, inspectable and validated.

---

## A note on persistence

A run that is waiting on its confirmation is held in memory, deliberately: the
durable half is the confirmation row, which expires in two minutes. If the server
restarts inside that window the pending run is lost and you are told the
confirmation expired — which is true — rather than the app resurrecting an action
you no longer expect.
