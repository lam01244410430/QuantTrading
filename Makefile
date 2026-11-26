PYTHON ?= python3

.PHONY: demo
demo:
	$(PYTHON) -m quanttrading.backtest fixtures/fixture_v1_basic.csv --out out --html
