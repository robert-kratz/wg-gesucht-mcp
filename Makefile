.PHONY: setup build check docker-check ci-local

setup:
	node scripts/setup-local.mjs

build:
	pnpm build

check:
	pnpm check

docker-check:
	docker compose run --rm --build check

ci-local:
	node scripts/test-ci.mjs
