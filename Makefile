.PHONY: test test-engine test-go test-web test-e2e test-ui test-repro lint-deploy test-proxy test-sortie test-restauration

test: test-engine test-go test-web test-e2e

# Moteur Rust : format, clippy sans avertissement (hôte, puis la liaison WebAssembly, le salon et sa liaison en wasm32),
# tests. --locked : Cargo.lock fait foi. cargo audit (réseau) tourne dans la CI (job engine).
test-engine:
	cd engine && cargo fmt --all --check
	cd engine && cargo clippy --workspace --all-targets --locked -- -D warnings
	cd engine && cargo clippy -p shhdrop-wasm --target wasm32-unknown-unknown --all-targets --locked -- -D warnings
	cd engine && cargo clippy -p shhdrop-salon --target wasm32-unknown-unknown --all-targets --locked -- -D warnings
	cd engine && cargo clippy -p shhdrop-salon-wasm --target wasm32-unknown-unknown --all-targets --locked -- -D warnings
	cd engine && cargo clippy -p shhdrop-jetons-wasm --target wasm32-unknown-unknown --all-targets --locked -- -D warnings
	cd engine && cargo test --workspace --locked

test-go:
	cd server && go vet ./... && go test -race ./... && GOARCH=386 go build ./...

test-web:
	cd web && npm test
	cd web && npm run build && node scripts/check-dist.mjs
	cd web && SHH_SITE_COMPTES=1 npm run build && node scripts/check-dist.mjs --comptes
	cd web && npm run build:demo && node scripts/check-dist.mjs --demo

test-e2e:
	cd server && go build -o shhdrop ./cmd/shhdrop
	cd web && npm run test:e2e

test-ui:
	cd web && npm run test:ui

# Build reproductible (spec §28.1) : deux builds dans deux dossiers, mêmes empreintes.
test-repro:
	web/scripts/repro.sh

# Scripts de déploiement et de build : syntaxe, ShellCheck (0.11.0 en CI, job deploy-lint),
# banc de l'alerte (deploy/test-alerte.sh, sans réseau), go vet et tests unitaires de deploy/shhcheck (module à part, hors de test-go : relais SMTP,
# contrôle SMTP ; les essais de banc, sans leurs variables, sont sautés).
lint-deploy:
	for f in deploy/*.sh web/scripts/*.sh; do bash -n "$$f" || exit 1; done
	shellcheck deploy/*.sh web/scripts/*.sh
	deploy/test-alerte.sh
	deploy/test-journaux.sh
	cd deploy/shhcheck && go vet ./... && go test -race -count=1 ./...

# Test du proxy (deploy/test-proxy.sh) : Caddy 2.10 ou plus dans le PATH (ou CADDY=…), site
# construit. La CI le lance avec l'image complète et le Caddy de compose.yaml (job repro-docker).
test-proxy:
	cd web && npm run build
	deploy/test-proxy.sh

# Sorties SMTP et paiement (deploy/test-sortie.sh) : configuration résolue de compose.yaml (docker compose
# config) ; puis, avec un démon Docker et SHH_IMAGE (image de cet arbre), le réseau réel. Code 3 :
# partie réseau non faite (aucun démon).
test-sortie:
	deploy/test-sortie.sh

# Sauvegarde et restauration de comptes.db et paiements.db (deploy/test-restauration.sh) : en root (montage
# tmpfs, serveur sous le compte 65532), age, sqlite3, Go. Aussi à chaque changement de schéma
# de comptes.db (conception du compte §21.13).
test-restauration:
	deploy/test-restauration.sh
