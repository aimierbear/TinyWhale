# golden-select.json provenance

Input:
- candidates: 5
- criteria: 3 (`root_cause`, `code_review`, `verification`)
- ring seed: 0

Upstream source: https://github.com/llm-as-a-verifier/llm-as-a-verifier at commit `115de305f23ed89bc42e86e010853c40059f3f7d`.

Generation:
- run upstream `pivot_tournament.select_best(n=5, ring=ring_cycle(5, random.Random(0)), k=2, score=<the fixed directed-score map recorded in this fixture>)`
- the fixture stores that exact ring, directed-score map, expected `selectedIndex`, `scores`, and `ranking`.

Recompute from the fixture:
- load `ring`, `scores`, and the expected fields;
- run the TS `selectBest` port with the same ring and score map;
- compare `selectedIndex`, `scores`, `ranking`, and `nComparisons`.
