#!/usr/bin/env bash

# Exit on error, treat unset vars as errors, and fail pipelines on first error.
set -euo pipefail

cd "$(dirname "$0")/.."
python -m uvicorn app.main:app --reload
