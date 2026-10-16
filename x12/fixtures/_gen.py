#!/usr/bin/env python3
"""One-off generator for the synthetic 835 fixtures in this folder.

Not part of the shipped parser or app — this script exists only so the raw EDI
segment text below is built by joining element lists with '*' (so delimiter
counts can never be miscounted by hand) instead of being hand-typed character
by character. Run `python3 _gen.py` from this directory to regenerate the
fixtures from the SPECS list below if they ever need to change.

Every fixture is entirely synthetic: fabricated patient/claim/provider IDs,
fabricated dollar amounts, ISA06 sender ID literally spells SYNTHETICNIMBIR.
The five CARC/RARC codes used (PR-1, CO-4, CO-45, CO-50, CO-97, N115) are the
only ones this build claims to have verified against x12.org — see
app/x12/carc-rarc.js and app/x12/fixtures/README.md.
"""
import os

EL = "*"
SUB = ":"
TERM = "~"


def seg(*elements):
    return EL.join("" if e is None else str(e) for e in elements)


def build(control_no, segments):
    """segments: list of element-lists for ST..SE (ST/SE added automatically)."""
    body = []
    st_index = len(body)
    body.append(["ST", "835", control_no, "005010X221A1"])
    body.extend(segments)
    body.append(["SE", str(len(segments) + 2), control_no])
    return body


def interchange(file_control, group_control, transactions, isa_date="261001", isa_time="0930"):
    out = []
    out.append(seg("ISA", "00", " " * 10, "00", " " * 10, "ZZ", "SYNTHETICNIMBIR",
                    "ZZ", "SYNTHCARDIOPAYR", isa_date, isa_time, "^", "00501",
                    file_control, "0", "T", SUB))
    out.append(seg("GS", "HP", "SYNTHETICNIMBIR", "SYNTHCARDIOPAYR",
                    "20" + isa_date, isa_time, group_control, "X", "005010X221A1"))
    se_count = 0
    for tx in transactions:
        for row in tx:
            out.append(seg(*row))
        se_count += 1
    out.append(seg("GE", str(se_count), group_control))
    out.append(seg("IEA", "1", file_control))
    return "\n".join(line + TERM for line in out) + "\n"


def payer_payee(payer_name="SYNTHETIC CARDIOLOGY PAYER CO", payee_name="SYNTHETIC CARDIOLOGY ASSOCIATES",
                payee_npi="1999999999", payee_tin="999999999"):
    return [
        ["N1", "PR", payer_name],
        ["N3", "1 SYNTHETIC PAYER WAY"],
        ["N4", "SYNTHCITY", "NY", "10001"],
        ["N1", "PE", payee_name, "XX", payee_npi],
        ["REF", "TJ", payee_tin],
    ]


def claim_header(cn, status, charge, paid, patresp, filing="CI", payer_claim="PAYERCLM" + "0000", facility="11", freq="1"):
    return ["CLP", cn, status, f"{charge:.2f}", f"{paid:.2f}",
            "" if patresp is None else f"{patresp:.2f}", filing, payer_claim, facility, freq]


def patient(last="SYNTHETICPATIENT", first="ONE", member="SYNTH00000001"):
    return ["NM1", "QC", "1", last, first, "", "", "", "MI", member]


def provider(name="SYNTHETIC CARDIOLOGY ASSOCIATES", npi="1999999999"):
    return ["NM1", "82", "2", name, "", "", "", "", "XX", npi]


def svc(qualifier, code, modifiers, charge, paid, units="1"):
    comp = SUB.join([qualifier, code] + modifiers)
    return ["SVC", comp, f"{charge:.2f}", f"{paid:.2f}", "", units]


def cas(group, *triplets):
    row = ["CAS", group]
    for reason, amount, qty in triplets:
        row += [reason, f"{amount:.2f}", "" if qty is None else qty]
    return row


def dtm(qualifier, date):
    return ["DTM", qualifier, date]


def lq(qualifier, code):
    return ["LQ", qualifier, code]


OUT_DIR = os.path.dirname(os.path.abspath(__file__))


def write(name, text):
    with open(os.path.join(OUT_DIR, name), "w", newline="\n") as f:
        f.write(text)
    print("wrote", name, len(text), "bytes")


# --- 1. 93306+93320 CO-97, and 93351+93015 CO-97 (two claims, bundling denial) ---
tx1 = build("0001", [
    ["BPR", "H", "0.00", "", "NON", "", "", "", "", "", "", "", "", "", "", "20261003"],
    ["TRN", "1", "TRACE0000001", "1SYNTHCARDIOPAYR"],
    ["DTM", "405", "20261003"],
] + payer_payee() + [
    claim_header("CARDIO-0001", "4", 750.00, 0.00, None, payer_claim="PAYERCLM0001"),
    patient(member="SYNTH00000001"),
    provider(),
    dtm("232", "20260815"),
    svc("HC", "93306", ["26"], 450.00, 0.00),
    dtm("472", "20260815"),
    cas("CO", ("97", 450.00, None)),
    svc("HC", "93320", [], 300.00, 0.00),
    dtm("472", "20260815"),
    cas("CO", ("97", 300.00, None)),
])
tx2 = build("0002", [
    ["BPR", "H", "0.00", "", "NON", "", "", "", "", "", "", "", "", "", "", "20261003"],
    ["TRN", "1", "TRACE0000002", "1SYNTHCARDIOPAYR"],
    ["DTM", "405", "20261003"],
] + payer_payee() + [
    claim_header("CARDIO-0002", "4", 620.00, 0.00, None, payer_claim="PAYERCLM0002"),
    patient(member="SYNTH00000002"),
    provider(),
    dtm("232", "20260818"),
    svc("HC", "93351", [], 380.00, 0.00),
    dtm("472", "20260818"),
    cas("CO", ("97", 380.00, None)),
    svc("HC", "93015", [], 240.00, 0.00),
    dtm("472", "20260818"),
    cas("CO", ("97", 240.00, None)),
])
write("synthetic-cardio-bundling-co97.835", interchange("000000001", "1", [tx1, tx2]))

# --- 2. 93224-26 CO-4 (modifier/procedure inconsistency denial) ---
tx = build("0001", [
    ["BPR", "H", "0.00", "", "NON", "", "", "", "", "", "", "", "", "", "", "20261004"],
    ["TRN", "1", "TRACE0000003", "1SYNTHCARDIOPAYR"],
    ["DTM", "405", "20261004"],
] + payer_payee() + [
    claim_header("CARDIO-0003", "4", 180.00, 0.00, None, payer_claim="PAYERCLM0003"),
    patient(member="SYNTH00000003"),
    provider(),
    dtm("232", "20260901"),
    svc("HC", "93224", ["26"], 180.00, 0.00),
    dtm("472", "20260901"),
    cas("CO", ("4", 180.00, None)),
])
write("synthetic-cardio-modifier-co4.835", interchange("000000002", "1", [tx]))

# --- 3. 99214-25 paid in full ---
tx = build("0001", [
    ["BPR", "C", "150.00", "C", "ACH", "CTX", "01", "999999999", "DA", "123456789", "", "", "", "", "", "20261005"],
    ["TRN", "1", "TRACE0000004", "1SYNTHCARDIOPAYR"],
    ["DTM", "405", "20261005"],
] + payer_payee() + [
    claim_header("CARDIO-0004", "1", 150.00, 150.00, 0.00, payer_claim="PAYERCLM0004"),
    patient(member="SYNTH00000004"),
    provider(),
    dtm("232", "20260902"),
    svc("HC", "99214", ["25"], 150.00, 150.00),
    dtm("472", "20260902"),
])
write("synthetic-cardio-paid-eval.835", interchange("000000003", "1", [tx]))

# --- 4. PR-1 deductible (patient responsibility, not a denial) ---
tx = build("0001", [
    ["BPR", "C", "100.00", "C", "ACH", "CTX", "01", "999999999", "DA", "123456789", "", "", "", "", "", "20261006"],
    ["TRN", "1", "TRACE0000005", "1SYNTHCARDIOPAYR"],
    ["DTM", "405", "20261006"],
] + payer_payee() + [
    claim_header("CARDIO-0005", "1", 140.00, 100.00, 40.00, payer_claim="PAYERCLM0005"),
    patient(member="SYNTH00000005"),
    provider(),
    dtm("232", "20260903"),
    svc("HC", "99213", ["25"], 140.00, 100.00),
    dtm("472", "20260903"),
    cas("PR", ("1", 40.00, None)),
])
write("synthetic-cardio-deductible-pr1.835", interchange("000000004", "1", [tx]))

# --- 5. Partial payment via routine contractual write-off (CO-45), not a flagged denial ---
tx = build("0001", [
    ["BPR", "C", "150.00", "C", "ACH", "CTX", "01", "999999999", "DA", "123456789", "", "", "", "", "", "20261007"],
    ["TRN", "1", "TRACE0000006", "1SYNTHCARDIOPAYR"],
    ["DTM", "405", "20261007"],
] + payer_payee() + [
    claim_header("CARDIO-0006", "1", 220.00, 150.00, 0.00, payer_claim="PAYERCLM0006"),
    patient(member="SYNTH00000006"),
    provider(),
    dtm("232", "20260904"),
    svc("HC", "93017", [], 220.00, 150.00),
    dtm("472", "20260904"),
    cas("CO", ("45", 70.00, None)),
])
write("synthetic-cardio-partial-payment.835", interchange("000000005", "1", [tx]))

# --- 6. CLP02=22 reversal of a previous payment + PLB recoupment tied to it ---
tx = build("0001", [
    ["BPR", "C", "0.00", "C", "ACH", "CTX", "01", "999999999", "DA", "123456789", "", "", "", "", "", "20261008"],
    ["TRN", "1", "TRACE0000007", "1SYNTHCARDIOPAYR"],
    ["DTM", "405", "20261008"],
] + payer_payee() + [
    claim_header("CARDIO-0007", "22", 95.00, 95.00, 0.00, payer_claim="PAYERCLM0007"),
    patient(member="SYNTH00000007"),
    provider(),
    dtm("232", "20260801"),
    svc("HC", "93306", [], 95.00, 95.00),
    dtm("472", "20260801"),
    ["PLB", "1999999999", "20261231", "WO" + SUB + "CARDIO-0007", "95.00"],
])
write("synthetic-cardio-reversal.835", interchange("000000006", "1", [tx]))

# --- 7. Echo denied CO-50 (not medically necessary) with RARC N115 (LCD) ---
tx = build("0001", [
    ["BPR", "H", "0.00", "", "NON", "", "", "", "", "", "", "", "", "", "", "20261009"],
    ["TRN", "1", "TRACE0000008", "1SYNTHCARDIOPAYR"],
    ["DTM", "405", "20261009"],
] + payer_payee() + [
    claim_header("CARDIO-0008", "4", 300.00, 0.00, None, payer_claim="PAYERCLM0008"),
    patient(member="SYNTH00000008"),
    provider(),
    dtm("232", "20260905"),
    svc("HC", "93306", ["TC"], 300.00, 0.00),
    dtm("472", "20260905"),
    cas("CO", ("50", 300.00, None)),
    lq("HE", "N115"),
])
write("synthetic-cardio-lcd-co50.835", interchange("000000007", "1", [tx]))

# --- 8. Multiple ST/SE in one interchange (paid 99214-25 + denied 93224-26 CO-4) ---
tx_a = build("0001", [
    ["BPR", "C", "150.00", "C", "ACH", "CTX", "01", "999999999", "DA", "123456789", "", "", "", "", "", "20261010"],
    ["TRN", "1", "TRACE0000009", "1SYNTHCARDIOPAYR"],
    ["DTM", "405", "20261010"],
] + payer_payee() + [
    claim_header("CARDIO-0009", "1", 150.00, 150.00, 0.00, payer_claim="PAYERCLM0009"),
    patient(member="SYNTH00000009"),
    provider(),
    dtm("232", "20260906"),
    svc("HC", "99214", ["25"], 150.00, 150.00),
    dtm("472", "20260906"),
])
tx_b = build("0002", [
    ["BPR", "H", "0.00", "", "NON", "", "", "", "", "", "", "", "", "", "", "20261010"],
    ["TRN", "1", "TRACE0000010", "1SYNTHCARDIOPAYR"],
    ["DTM", "405", "20261010"],
] + payer_payee() + [
    claim_header("CARDIO-0010", "4", 180.00, 0.00, None, payer_claim="PAYERCLM0010"),
    patient(member="SYNTH00000010"),
    provider(),
    dtm("232", "20260907"),
    svc("HC", "93224", ["26"], 180.00, 0.00),
    dtm("472", "20260907"),
    cas("CO", ("4", 180.00, None)),
])
write("synthetic-cardio-multi-st.835", interchange("000000008", "1", [tx_a, tx_b]))
