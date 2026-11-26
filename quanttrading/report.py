from decimal import Context, Decimal, localcontext
from html import escape

from .constants import FILL_COLUMNS


def _equity_chart(rows):
    values = [Decimal(row[4]) for row in rows]
    low, high = min(values), max(values)
    with localcontext(Context(prec=34)):
        points = " ".join(
            f"{40 + i * Decimal(600) / (len(values) - 1):.2f},"
            f"{100 if low == high else 20 + (high - value) * 160 / (high - low):.2f}"
            for i, value in enumerate(values)
        )
    return f"""
    <h2>Equity by bar</h2>
    <figure>
      <svg viewBox="0 0 680 200" role="img" aria-labelledby="equity-title">
        <title id="equity-title">Closing equity from {rows[0][0]} to {rows[-1][0]}</title>
        <path d="M40 20V180H640" fill="none" stroke="#6c8099"/>
        <polyline fill="none" stroke="#165f99" stroke-width="3" points="{points}"/>
      </svg>
      <figcaption>{rows[0][0]} to {rows[-1][0]} ·
        Equity range: {low} to {high} (account currency)</figcaption>
    </figure>"""


def _fills_table(fills):
    headings = "".join(f'<th scope="col">{column.replace("_", " ").capitalize()}</th>'
                       for column in FILL_COLUMNS)
    rows = "".join(
        "<tr>" + "".join(f"<td>{escape(value)}</td>" for value in fill) + "</tr>"
        for fill in fills
    )
    if not rows:
        rows = f'<tr><td colspan="{len(FILL_COLUMNS)}">No simulated fills.</td></tr>'
    return f"""
    <h2>Simulated fills</h2>
    <div class="table"><table>
      <thead><tr>{headings}</tr></thead><tbody>{rows}</tbody>
    </table></div>"""


def render_report(summary, fills, equity):
    parameters = summary["parameters"]
    details = {**{key: value for key, value in summary.items()
                  if key not in ("disclaimer", "parameters")}, **parameters}
    items = "".join(
        f"<dt>{key.replace('_', ' ').capitalize()}</dt><dd>{escape(value) or '—'}</dd>"
        for key, value in details.items()
    )
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QuantTrading backtest</title>
  <style>
    body {{ font: 1rem/1.5 system-ui, sans-serif; color: #172b45; background: #f4f7fb;
            max-width: 68rem; margin: 2rem auto; padding: 0 1rem; }}
    h1, h2 {{ line-height: 1.15; }}
    section {{ background: white; border: 1px solid #cfdded; border-radius: .5rem;
               padding: 1rem; margin: 1rem 0; }}
    dl {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
          gap: .75rem; }}
    dt {{ font-weight: bold; }}
    dd {{ margin: 0; overflow-wrap: anywhere; }}
    figure {{ margin: 0; }}
    svg {{ display: block; width: 100%; }}
    .table {{ overflow-x: auto; }}
    table {{ border-collapse: collapse; width: 100%; }}
    th, td {{ text-align: left; padding: .45rem; border-bottom: 1px solid #cfdded; }}
  </style>
</head>
<body>
<main>
  <h1>QuantTrading backtest · {escape(summary["symbol"])}</h1>
  <p>{escape(summary["disclaimer"])}</p>
  <section>{_equity_chart(equity)}
  </section>
  <section>
    <h2>Run summary</h2>
    <dl>{items}</dl>
  </section>
  <section>{_fills_table(fills)}
  </section>
</main>
</body>
</html>
"""
