# Supabase project

Project: **English_Test_v2** (region ap-southeast-1, Singapore), reference `lbhnadqmokloyfarrzfv`.

- The database schema is stored in the project as migrations `v2_01` to `v2_11`.
- Edge Functions live in `../backend/functions` (`auth-me`, `question-bank`, `media`).

To keep the SQL of the migrations in this repository, run this once on your computer with the Supabase CLI:

```
supabase login
supabase link --project-ref lbhnadqmokloyfarrzfv
supabase db pull
```

That writes the migration files into `supabase/migrations/`. Commit them.

Deploying a function from this repository:

```
supabase functions deploy question-bank --project-ref lbhnadqmokloyfarrzfv --no-verify-jwt
```

Functions check who is calling themselves (`requireStaff`), which is why gateway JWT verification is off.
Never put the service role key, passwords, or any `.env` file in this repository.
