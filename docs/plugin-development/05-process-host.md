# 05 Process Host

Third-party extensions run through the existing Process Extension Host. The Extension Runtime validates, reviews, starts, stops, and routes capabilities; Plugin Center does not introduce a second runtime.

The Process Host reduces direct access to Desktop process objects. It is not Windows Sandbox and is not a complete OS boundary against hostile native code. The in-process VM used by the local sample fixture is not a promise about Catalog plugin hosting.
