# Does letting Nemotron pick the size pay?

Huddle's router can send each ask to the assistant that fits it, judged by NVIDIA Nemotron 3.5 Lightning on
Nebius Token Factory. This measures that against the obvious alternative, sending everything to your best
assistant, on 24 everyday asks (8 quick ones, 8 messages to write, 8 plans), on 16 October 2026.

| | Auto (Nemotron picks) | Always the best (Ultra, thinking) |
|---|---|---|
| Quick asks (8) | **$0.00025**, median 1.15 s | $0.00464, median 0.97 s |
| Writing (8) | **$0.00141**, median 1.81 s | $0.01023, median 2.52 s |
| Plans (8) | $0.06311, median 10.4 s | $0.06094, median 9.8 s |
| All 24 | $0.0648 | $0.0758 |

- **It picked right every time:** all 24 asks went to the assistant made for them (Lightning for quick
  answers, Super for writing, Ultra with thinking for plans). The judge's own calls are in auto's cost.
- **Everyday asks cost 89% less** (quick and writing together: $0.0017 against $0.0149, 9 times less),
  and writing was faster too. Plans go to Ultra either way, so the total saving is 15%: what you save
  depends on how much of your day is quick asks and messages rather than plans.
- **Quality, graded blind by Nemotron Super** (the two answers in random order, unlabelled; the model that
  wrote one of them never grades): writing, auto better on 5 of 8; quick asks, the big model better on 4 of
  8, tied on 3; plans, 4 each. Plans are the control: both sides are the same Ultra, so a 4–4 split is the
  grader's own noise. Read the quick-ask result as a small cost in quality for a 95% saving.

## Run it yourself

```bash
NEBIUS_API_KEY=... node --no-warnings docs/benchmarks/routing.ts
```

It builds the three assistants in memory, asks the 24 questions both ways through Huddle's real router,
grades each pair, and writes [`routing-results.json`](routing-results.json): every ask, where it went,
what each side cost, how long it took, and the verdict. A run costs about $0.15 of Token Factory credit.
Prices are Token Factory's listed ones on the tokens each call reports.
