# Inference alarm fixture: expected matches

`relay-log-lines.txt` holds one CloudWatch log event per line, for `aws logs test-metric-filter
--log-event-messages`. The relay (Node 22 runtime, Text log format) prefixes each `console.info` line with
`<timestamp>\t<request id>\tINFO\t`. The API runs `node api.mjs` behind the Lambda Web Adapter (`run.sh`), so its
`consoleInferenceLogger` lines reach CloudWatch as bare JSON. Shapes come from `consoleInferenceLogger`
(`src/inference/index.ts`), `LambdaRelayModelInference.finish` (`src/inference/lambda-relay-inference.ts`), the
relay's `InferenceRelayLogRecord` (`src/aws/inference-relay-lambda.ts`) and `BedrockModelInference`
(`src/inference/bedrock-inference.ts`).

Filters (`infra/lib/backend-stack.ts`):

- **Failures** `InferenceRelayFailures`, relay log group: `?"not_configured" ?"unavailable" ?"timeout"`
- **Refusals** `InferenceRelayRefusals`, relay log group: `"model_inference" "refused"`
- **Invoke** `InferenceRelayInvokeFailures`, API log group: `"model_inference" "bedrock-relay" "failure"`

"Pattern" columns say whether the pattern alone matches the line, which is what `test-metric-filter` reports.
A filter counts only lines in its own log group. Those are the lines in **bold** under "Counted by".

| Line | Log group | Case                                                        | Failures | Refusals | Invoke | Counted by   |
| ---- | --------- | ----------------------------------------------------------- | -------- | -------- | ------ | ------------ |
| 1    | API       | Relay turn failed: `unavailable` (throttle, grant, crash)   | yes      | no       | yes    | **Invoke**   |
| 2    | API       | Relay turn failed: `timeout` (API abort)                    | yes      | no       | yes    | **Invoke**   |
| 3    | API       | Relay turn succeeded (`ok: true`)                           | no       | no       | no     | none         |
| 4    | API       | Relay answered `refused` (guardrail), passed through by API | no       | yes      | yes    | **Invoke**   |
| 5    | API       | Direct Bedrock (`bedrock`); never on STAGING, which refuses | yes      | no       | no     | none         |
| 6    | Relay     | `inference_relay_refused`, reason `not_configured`          | yes      | no       | no     | **Failures** |
| 7    | Relay     | `inference_relay_refused`, reason `environment`             | no       | no       | no     | none         |
| 8    | Relay     | `inference_relay_refused`, reason `request` (malformed)     | no       | no       | no     | none         |
| 9    | Relay     | `model_inference` failure `refused` (guardrail)             | no       | yes      | no     | **Refusals** |
| 10   | Relay     | `model_inference` failure `invalid`                         | no       | no       | no     | none         |
| 11   | Relay     | `model_inference` failure `unavailable`                     | yes      | no       | no     | **Failures** |
| 12   | Relay     | `model_inference` succeeded (`ok: true`)                    | no       | no       | no     | none         |
