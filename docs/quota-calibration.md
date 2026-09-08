# Quota calibration, September 8, 2026

Production uses 13,200,000 saved weight units per account percentage point. This is an empirical estimate for the observed account, not an OpenAI-published weekly allowance.

The previous 18,600,000 conversion came from the largest single-point interval. It was too sensitive to rounding, request timing, and delays. It predicted only 5.62 points during a later eight-point rise with fully reported activity.

The replacement was chosen by rounding up the first complete four-point span below. The subsequent spans check it against later activity. Times are UTC on September 7, 2026.

| Use         | Start        | End          | Account increase | Saved weight | Prediction at 13,200,000 |
| ----------- | ------------ | ------------ | ---------------: | -----------: | -----------------------: |
| Calibration | 23:13:32.973 | 23:31:11.372 |         4 points |   52,465,490 |             3.975 points |
| Later check | 23:31:11.372 | 23:45:19.095 |         4 points |   52,016,310 |             3.941 points |
| Later check | 23:45:19.095 | 23:51:42.724 |          1 point |   12,700,680 |             0.962 points |

Method: extract the first local `token_count` quota observation at each percentage, then sum server-received request weights whose `recorded_at` falls in `(start, end]`. Use the existing `estimateUsageWeight` function at pricing version `2026-09-05.1`. The first two spans contain 100 and 122 requests respectively. All requests in these spans report GPT-6 Astra and a known service tier. Only one registered member reported requests during these spans. Token counts, prompts, device identities, and individual request records are not needed in this report.

These checks show agreement with account changes during the observed workload. They do not establish causation or exclude activity on untracked devices. Quota readings are rounded and sometimes arrive out of order. The calibration is not independently validated for every model or request size. Earlier spans with missing service tiers were excluded; treating those as confirmed Standard would bias the calibration. Historical estimates with missing details remain partial.

Do not fit the conversion to the whole week's account total. That would assign unknown activity to registered members again. Member estimates must remain independent of account movements and other members' reports. Keep the conversion fixed until deliberate calibration has better evidence. Future quota observations are retained server-side to make that check possible without another collector release.

The [published pricing and usage documentation](https://learn.chatgpt.com/docs/pricing) describes shared usage and model credit rates, but supplies no per-device quota ledger or absolute weekly credit budget for this account. An unexplained difference is therefore not proof of an unknown user's consumption.
