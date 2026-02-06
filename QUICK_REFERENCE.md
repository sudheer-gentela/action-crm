# Action CRM - Quick Reference Card
## Keep This Handy During Installation

---

## 📝 Installation Checklist

```
PHASE 1: PREREQUISITES (15 min)
[ ] Install Node.js from nodejs.org
[ ] Install Git from git-scm.com/download/win
[ ] Create GitHub account at github.com/join
[ ] Create Railway account at railway.app (use GitHub)
[ ] Create Vercel account at vercel.com/signup (use GitHub)

PHASE 2: PREPARE CODE (5 min)
[ ] Extract action-crm-clean.zip to C:\action-crm-clean
[ ] Verify folders exist: backend, frontend

PHASE 3: PUSH TO GITHUB (10 min)
[ ] Open CMD in C:\action-crm-clean
[ ] git init
[ ] git add .
[ ] git commit -m "Initial commit"
[ ] Create repo at github.com/new (name: action-crm)
[ ] git remote add origin https://github.com/USERNAME/action-crm.git
[ ] git push -u origin main

PHASE 4: RAILWAY BACKEND (20 min)
[ ] New Project → Provision PostgreSQL
[ ] PostgreSQL → Data → Query → Paste database-schema.sql → Run
[ ] New → GitHub Repo → Select action-crm
[ ] Settings → Root Directory: backend
[ ] Settings → Start Command: node server.js
[ ] Variables → Add 11 variables (see list below)
[ ] Settings → Generate Domain → Copy URL: __________
[ ] Wait for deployment → Test /health endpoint

PHASE 5: VERCEL FRONTEND (15 min)
[ ] New Project → Import action-crm from GitHub
[ ] Root Directory: frontend
[ ] Add Environment Variable:
    REACT_APP_API_URL = RAILWAY-URL/api
[ ] Deploy → Wait for completion
[ ] Copy Vercel URL: __________
[ ] Railway → CORS_ORIGIN = VERCEL-URL (no trailing /)

PHASE 6: TEST (10 min)
[ ] Open Vercel URL
[ ] Login with any email/password
[ ] Test all tabs: Actions, Deals, Accounts, Contacts, Email, Calendar
[ ] Press F12 → Check console for errors
[ ] All working? DONE! 🎉
```

---

## 🔑 Railway Environment Variables

**COPY THIS LIST - Add each one in Railway:**

```
1.  NODE_ENV = production
2.  PORT = 3001
3.  JWT_SECRET = [Generate at: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"]
4.  JWT_EXPIRES_IN = 7d
5.  CORS_ORIGIN = * (update later to Vercel URL)
6.  DATABASE_URL = ${{Postgres.DATABASE_URL}}
7.  DB_HOST = ${{Postgres.PGHOST}}
8.  DB_PORT = ${{Postgres.PGPORT}}
9.  DB_NAME = ${{Postgres.PGDATABASE}}
10. DB_USER = ${{Postgres.PGUSER}}
11. DB_PASSWORD = ${{Postgres.PGPASSWORD}}
```

---

## 📐 Vercel Settings

```
Framework Preset:    Create React App
Root Directory:      frontend    ← CRITICAL!
Build Command:       npm run build
Output Directory:    build
Install Command:     npm install

Environment Variable:
Name:  REACT_APP_API_URL
Value: https://YOUR-RAILWAY-URL.railway.app/api
       ↑ Must end with /api
```

---

## 🐛 Quick Troubleshooting

| Problem | Solution |
|---------|----------|
| CORS Error | Railway → Variables → CORS_ORIGIN = exact Vercel URL (no /) |
| Network Error | Vercel → Environment Variables → Check ends with /api |
| Backend won't start | Railway → Check Root Directory = backend |
| Frontend build fails | Vercel → Check Root Directory = frontend |
| Can't push to GitHub | Generate token at github.com/settings/tokens |
| Database error | Railway → Check DATABASE_URL = ${{Postgres.DATABASE_URL}} |

---

## 🔗 Important URLs

```
Node.js Download:    https://nodejs.org/
Git Download:        https://git-scm.com/download/win
GitHub Sign Up:      https://github.com/join
Railway Dashboard:   https://railway.app/dashboard
Vercel Dashboard:    https://vercel.com/dashboard

Generate JWT Secret:
Method 1: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
Method 2: https://www.random.org/strings/

GitHub Token:        https://github.com/settings/tokens
Railway Status:      https://railway.app/status
Vercel Status:       https://vercel-status.com
```

---

## 📞 My Deployment Info

```
GitHub Username:     ______________________________
Repository:          https://github.com/________/action-crm
Railway Backend:     https://____________.up.railway.app
Vercel Frontend:     https://____________.vercel.app
JWT Secret:          ______________________________ (SAVE THIS!)
Deployed On:         ______________________________
```

---

## ⚡ Super Quick Command Reference

### Git Commands
```cmd
git init                              # Initialize repository
git add .                             # Stage all files
git commit -m "message"               # Save changes
git push origin main                  # Upload to GitHub
```

### Generate JWT Secret
```cmd
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Test URLs
```
Backend Health:  https://YOUR-BACKEND-URL.railway.app/health
Frontend:        https://YOUR-FRONTEND-URL.vercel.app
```

---

## ✅ Success Indicators

**Railway Backend:**
- ✅ Deployment shows green "SUCCESS"
- ✅ /health endpoint returns {"status":"ok"}
- ✅ All 11 variables are set
- ✅ Database has data (SELECT COUNT(*) FROM users returns 1+)

**Vercel Frontend:**
- ✅ Build completes successfully
- ✅ Can open the URL
- ✅ See login screen
- ✅ Can login with any credentials
- ✅ All 6 tabs load without errors
- ✅ No red errors in console (F12)

---

## 🎯 Common Mistakes to Avoid

❌ **Don't:** Put react-scripts in devDependencies
✅ **Do:** Put it in dependencies

❌ **Don't:** Forget `/api` at end of REACT_APP_API_URL
✅ **Do:** Include it: https://backend.railway.app/api

❌ **Don't:** Add trailing slash to CORS_ORIGIN
✅ **Do:** Just the URL: https://frontend.vercel.app

❌ **Don't:** Skip setting Root Directory
✅ **Do:** Set backend and frontend respectively

❌ **Don't:** Use your GitHub password when pushing
✅ **Do:** Generate and use a Personal Access Token

---

## ⏱️ Time Estimates

If you get stuck, don't worry! Here's how long each phase should take:

- Prerequisites: 15 minutes (one-time only)
- GitHub push: 10 minutes
- Railway setup: 20 minutes
- Vercel deploy: 15 minutes
- Testing: 10 minutes

**Total first-time: ~70 minutes**
**Subsequent deploys: ~5 minutes** (just git push!)

---

## 💡 Pro Tips

1. **Write down URLs immediately** as you get them
2. **Save your JWT_SECRET** somewhere safe
3. **Take screenshots** of successful deployments
4. **Test backend first** before deploying frontend
5. **Check logs** if something fails - they tell you exactly what's wrong
6. **Use exact URLs** - no typos in CORS_ORIGIN or API_URL

---

**Print this card and keep it next to you during installation!**

**Full guide:** COMPLETE_INSTALLATION_GUIDE.md

**Need help?** Check the Troubleshooting section in the guide.

---

**🚀 Ready to deploy? You've got this!** 💪
