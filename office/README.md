# 812 Sensory agent office

A small team of scheduled Claude runs ("agents") that work for Brittany, plus the **Daily Brief** page (`/brief`) where she reads what they did and answers what they ask. Everything they file lives in the shop's Supabase project (`mkwthdcpafpmxwpdgbov`) in tables prefixed `office_`.

## How it fits together

```
Wix store/bookings · Gmail (order mail) · web search
            │
   scheduled agents (fresh Claude session each run, read the DB, do the job, write the DB)
            │
   office_* tables  ◄──── Brittany taps on /brief (decisions, reminders, events board, settings, standing orders)
            │
   The Chief (6:48 am / 4:48 pm) → office_briefs → email to the notify list
```

- `schema.sql` – the tables, row-level security (same `is_allowed()` rule as the shop) and the realtime publication.
- `seed_agents.sql` – the ten desks: five live (Chief, Till, Booker, Scout, Stock) and five "starting soon" (Post, Inbox, Ledger, Hello, Site). Each row's `instructions` column is the agent's editable standing orders; Brittany edits them from The Office tab.
- `build_prompts.py` → `agents/<id>.md` – the fixed part of each scheduled task's prompt: run protocol, data recipes, safety rules. Regenerate after editing and paste into the scheduled task.
- `../brief.html` + `../brief.js` – the Daily Brief page. Same sign-in as the shop app (Supabase Auth + `allowed_users`).

## Run protocol (every agent)

1. Read its own `office_agents` row; if `enabled` is false, record a skipped run and stop. Follow `instructions`.
2. Read `office_settings` (thresholds, notify list, greetings, party menu).
3. Open a row in `office_runs`, set the desk to `running` with a `current_task` Brittany can read live.
4. Log plain-English lines to `office_run_events` as it works.
5. Write results to its tables; reminders to `office_tasks`, choices to `office_decisions` (never duplicated by title).
6. Close the run with a one-sentence summary and stats; update the desk card.

Safety: read-only everywhere except the office database; no customer contact; only The Chief sends email, and only to `office_settings.notify.emails`.

## Schedules (America/Indianapolis)

| Agent | Schedule | Default lookback on first run |
| --- | --- | --- |
| Till | every 2 h, 7 am–9 pm | 45 days |
| Booker | 6:25 am, 4:25 pm | 60 days |
| Stock | 5:40 am | n/a |
| Scout | Monday 5:15 am | n/a |
| The Chief | 6:48 am, 4:48 pm | previous brief |

## Tables

`office_agents` (desks), `office_runs` + `office_run_events` (the log), `office_briefs`, `office_decisions`, `office_tasks`, `office_orders`, `office_bookings`, `office_events`, `office_insights`, `office_posts` and `office_messages` (phase 2), `office_settings` (key/value json).

## Still manual

- Etsy and TikTok Shop have no API access yet: forward their order notifications to the mailbox the Gmail connector reads (`cclark@mostly3d.com`) and Till will file them from the emails.
- Post and Inbox wait on a Meta developer app (Instagram and Facebook) and a media inbox folder.
- Push notifications: email first; web push can reuse the family app's push plumbing later.
