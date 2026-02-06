# Action CRM - Complete Clean Installation Guide
## From Zero to Deployed in 60 Minutes

This is a **complete, clean installation** from scratch. No previous setup required.

---

## 📦 What You're Installing

A full-stack CRM application with:
- ✅ **Backend**: Node.js/Express API + PostgreSQL database (Railway)
- ✅ **Frontend**: React application (Vercel)
- ✅ **Features**: Login, Deals, Accounts, Contacts, Email, Calendar
- ✅ **Auto-deploy**: Push to GitHub = automatic deployment

---

## ⏱️ Time Required

- **Prerequisites**: 15 minutes (one-time setup)
- **Backend Deployment**: 20 minutes
- **Frontend Deployment**: 15 minutes
- **Testing**: 10 minutes
- **Total**: ~60 minutes

---

## PART 1: Prerequisites (15 minutes)

### Step 1: Install Node.js

1. Go to: **https://nodejs.org/**
2. Click the **LEFT green button** (LTS version)
3. Download and run the installer
4. Click "Next" through all screens
5. Wait for installation
6. **Verify**: Open Command Prompt (Windows Key + R, type `cmd`, Enter)
   ```cmd
   node --version
   ```
   Should show: `v18.XX.X` or `v20.XX.X`

✅ Node.js installed!

---

### Step 2: Install Git

1. Go to: **https://git-scm.com/download/win**
2. Download starts automatically
3. Run the installer
4. Click "Next" on ALL screens (use defaults)
5. Wait for installation
6. **Verify**: In Command Prompt:
   ```cmd
   git --version
   ```
   Should show: `git version 2.XX.X`

✅ Git installed!

---

### Step 3: Create Online Accounts

**GitHub (code storage):**
1. Go to: **https://github.com/join**
2. Create account with email/password
3. Verify your email
4. Write down your username: _______________

**Railway (backend + database):**
1. Go to: **https://railway.app/**
2. Click "Login with GitHub"
3. Authorize Railway

**Vercel (frontend):**
1. Go to: **https://vercel.com/signup**
2. Click "Continue with GitHub"  
3. Authorize Vercel

✅ All accounts created!

---

## PART 2: Download and Prepare Code (5 minutes)

### Step 1: Download the Package

You should have received: `action-crm-clean.zip`

### Step 2: Extract Files

1. Find `action-crm-clean.zip` in your Downloads
2. **Right-click** → "Extract All..."
3. Choose destination: `C:\`
4. Click "Extract"
5. You should now have: `C:\action-crm-clean`

### Step 3: Verify File Structure

Open File Explorer and navigate to `C:\action-crm-clean`

You should see:
```
action-crm-clean/
├── backend/                 ← Backend API code
├── frontend/                ← React app code
├── database-schema.sql      ← Database structure
└── README.md               ← This guide
```

✅ Files extracted!

---

## PART 3: Push Code to GitHub (10 minutes)

### Step 1: Open Command Prompt in Project Folder

1. Open File Explorer
2. Navigate to `C:\action-crm-clean`
3. Click in the **address bar** at the top
4. Type: `cmd` and press Enter
5. A black Command Prompt window opens

You should see:
```
C:\action-crm-clean>
```

### Step 2: Configure Git (One-Time Only)

Type these commands (replace with YOUR info):

```cmd
git config --global user.name "Your Name"
```
Press Enter.

```cmd
git config --global user.email "your.email@example.com"
```
Press Enter.

**Example:**
```cmd
git config --global user.name "John Smith"
git config --global user.email "john@example.com"
```

### Step 3: Initialize Git Repository

Type each command and press Enter:

```cmd
git init
```

```cmd
git add .
```

```cmd
git commit -m "Initial commit - Action CRM clean install"
```

You'll see files being saved.

### Step 4: Create GitHub Repository

**Don't close Command Prompt!** Open your browser:

1. Go to: **https://github.com/new**
2. Repository name: `action-crm`
3. Keep it **Public** (free deployment)
4. **DO NOT** check any boxes
5. Click **"Create repository"**

### Step 5: Push to GitHub

Back in Command Prompt, type (replace YOUR-USERNAME with your GitHub username):

```cmd
git branch -M main
```

```cmd
git remote add origin https://github.com/YOUR-USERNAME/action-crm.git
```

```cmd
git push -u origin main
```

**If it asks for login:**
- **Option A**: Browser opens → Click "Authorize" → Done
- **Option B**: Needs credentials:
  - Username: your GitHub username
  - Password: Create a token at https://github.com/settings/tokens
    - Click "Generate new token (classic)"
    - Name: `action-crm`
    - Check: `repo`
    - Copy the token
    - Use as password

Wait for upload (30 seconds).

### Step 6: Verify Upload

Go to: `https://github.com/YOUR-USERNAME/action-crm`

You should see your files: `backend`, `frontend`, etc.

✅ Code on GitHub!

---

## PART 4: Deploy Backend to Railway (20 minutes)

### Step 1: Create Database

1. Go to: **https://railway.app/dashboard**
2. Click **"New Project"**
3. Click **"Provision PostgreSQL"**
4. Wait 10 seconds
5. A purple PostgreSQL box appears

✅ Database created!

### Step 2: Import Database Schema

**Method: Web Console (Easiest)**

1. Click the **PostgreSQL** box
2. Click **"Data"** tab
3. Click **"Query"** button
4. Now get the schema:
   - Open File Explorer
   - Go to: `C:\action-crm-clean`
   - Double-click `database-schema.sql` (opens in Notepad)
   - Press **Ctrl + A** (select all)
   - Press **Ctrl + C** (copy)
5. Go back to Railway browser
6. In the Query box: **Ctrl + V** (paste)
7. Click **"Run Query"**
8. Wait 5-10 seconds
9. Should see: "Query executed successfully"

**Verify:**
1. Clear the query box
2. Type: `SELECT COUNT(*) FROM users;`
3. Click "Run Query"
4. Should see a number (like 1)

✅ Database has tables and sample data!

### Step 3: Deploy Backend from GitHub

1. Go back to Railway project (click project name at top)
2. Click **"+ New"** button
3. Choose **"GitHub Repo"**
4. You'll see your repositories
5. Click **"action-crm"**
6. Railway starts deploying

### Step 4: Configure Backend Settings

1. Click on the new service (blue box labeled "action-crm")
2. Click **"Settings"** tab
3. Scroll to **"Build & Deploy"** section
4. Find **"Root Directory"**
5. Click the field
6. Type: `backend`
7. Click checkmark or press Enter
8. Find **"Start Command"**
9. Type: `node server.js`
10. Click away to save

### Step 5: Add Environment Variables

Still in the backend service, click **"Variables"** tab.

**Add these variables ONE BY ONE:**

Click **"+ New Variable"** for each:

**Variable 1:**
```
Name: NODE_ENV
Value: production
```

**Variable 2:**
```
Name: PORT
Value: 3001
```

**Variable 3 - IMPORTANT (Generate Random String):**
```
Name: JWT_SECRET
Value: (see below)
```

**To generate JWT_SECRET:**
- Go to: **https://www.random.org/strings/**
- Or open a new Command Prompt and type:
  ```cmd
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- Copy the random string
- Paste as JWT_SECRET value

**Variable 4:**
```
Name: JWT_EXPIRES_IN
Value: 7d
```

**Variable 5:**
```
Name: CORS_ORIGIN
Value: *
```
(We'll update this later with your Vercel URL)

**Variables 6-11 (Database Connection):**

For each of these, click **"+ New Variable"** → then click dropdown:

```
Name: DATABASE_URL
Value: Click dropdown → Select "${{Postgres.DATABASE_URL}}"
```

```
Name: DB_HOST  
Value: Select "${{Postgres.PGHOST}}"
```

```
Name: DB_PORT
Value: Select "${{Postgres.PGPORT}}"
```

```
Name: DB_NAME
Value: Select "${{Postgres.PGDATABASE}}"
```

```
Name: DB_USER
Value: Select "${{Postgres.PGUSER}}"
```

```
Name: DB_PASSWORD
Value: Select "${{Postgres.PGPASSWORD}}"
```

### Step 6: Generate Domain for Backend

1. Go to **"Settings"** tab
2. Scroll to **"Networking"** section
3. Click **"Generate Domain"**
4. Wait a few seconds
5. You'll get a URL like: `https://action-crm-production-XXXX.up.railway.app`

**WRITE DOWN THIS URL!** You'll need it for frontend.

Your backend URL: ________________________________

### Step 7: Wait for Deployment

1. Click **"Deployments"** tab
2. Watch the build logs
3. Wait for **green "SUCCESS"** checkmark
4. Takes 2-3 minutes

### Step 8: Test Backend

Open browser and go to:
```
https://YOUR-RAILWAY-URL.up.railway.app/health
```

Replace YOUR-RAILWAY-URL with your actual URL.

You should see:
```json
{"status":"ok","timestamp":"2024-XX-XX..."}
```

✅ **Backend is LIVE!**

---

## PART 5: Deploy Frontend to Vercel (15 minutes)

### Step 1: Import Project to Vercel

1. Go to: **https://vercel.com/dashboard**
2. Click **"Add New..."** → **"Project"**
3. Click **"Import Git Repository"**
4. Find **"action-crm"** in the list
5. Click **"Import"**

### Step 2: Configure Build Settings

**You'll see "Configure Project" screen:**

1. **Framework Preset**: Should say "Create React App" (auto-detected)
   - If not, manually select it

2. **Root Directory**: 
   - Click **"Edit"** button
   - Type: `frontend`
   - ⚠️ **CRITICAL** - Must be set!

3. **Build Command**: Should say `npm run build` (leave it)

4. **Output Directory**: Should say `build` (leave it)

5. **Install Command**: Should say `npm install` (leave it)

### Step 3: Add Environment Variable

Scroll to **"Environment Variables"** section:

1. Click to expand it
2. Fill in:
   - **Name**: `REACT_APP_API_URL`
   - **Value**: Your Railway backend URL + `/api`
   - Example: `https://action-crm-production-XXXX.up.railway.app/api`
   - ⚠️ **MUST end with `/api`**
3. Leave all checkboxes checked (Production, Preview, Development)

### Step 4: Deploy!

1. Click the big **"Deploy"** button
2. Wait 3-5 minutes
3. Watch the build logs
4. You'll see:
   - "Building..."
   - "Deploying..."
   - "✓ Deployment complete" 🎉

### Step 5: Get Your Frontend URL

On the success screen:
- You'll see your URL: `https://action-crm-XXXX.vercel.app`
- Click **"Visit"** or copy the URL

**WRITE DOWN THIS URL!**

Your frontend URL: ________________________________

### Step 6: Update CORS on Railway

Now we need to tell the backend to accept requests from Vercel:

1. Go back to Railway
2. Click your **backend service** (blue box)
3. Click **"Variables"** tab
4. Find **CORS_ORIGIN**
5. Click to edit
6. Change from `*` to your Vercel URL
   - Example: `https://action-crm-XXXX.vercel.app`
   - ⚠️ **NO trailing slash!**
7. Press Enter or click away to save
8. Backend will auto-redeploy (30 seconds)

---

## PART 6: Test Your Application! (10 minutes)

### Step 1: Open Your App

Go to your Vercel URL in a browser:
```
https://action-crm-XXXX.vercel.app
```

You should see a beautiful login screen with the ⚡ logo!

### Step 2: Login

**This is DEMO MODE - use any credentials:**

1. Email: `test@example.com` (or anything)
2. Password: `password` (or anything)
3. Click **"Sign In"**

You'll be logged in to the dashboard!

### Step 3: Explore All Features

**Test each tab:**

1. **Actions Tab** (default)
   - ✅ See action feed
   - ✅ View sample actions

2. **Deals Tab**
   - ✅ See pipeline columns
   - ✅ View deal card

3. **Accounts Tab**
   - ✅ See company cards
   - ✅ View account details

4. **Contacts Tab**
   - ✅ See contact list

5. **Email Tab**
   - ✅ See inbox
   - ✅ View sample emails

6. **Calendar Tab**
   - ✅ See meetings

### Step 4: Check Browser Console

1. Press **F12** on keyboard
2. Click **"Console"** tab
3. Look for errors (RED text)

**Good**: No red errors
**Bad**: CORS errors or Network errors

**If you see CORS errors:**
- Go to Railway → Backend → Variables
- Check CORS_ORIGIN matches Vercel URL EXACTLY
- No `www.`, no trailing `/`
- Redeploy

---

## ✅ Success Checklist

- [ ] Node.js installed (v18+)
- [ ] Git installed
- [ ] GitHub account created
- [ ] Railway account created
- [ ] Vercel account created
- [ ] Code pushed to GitHub (visible at github.com/YOUR-USERNAME/action-crm)
- [ ] PostgreSQL database created on Railway
- [ ] Database schema imported successfully
- [ ] Backend deployed to Railway
- [ ] Backend URL working (/health returns ok)
- [ ] All 11 environment variables set on Railway
- [ ] Frontend deployed to Vercel
- [ ] REACT_APP_API_URL set on Vercel
- [ ] CORS_ORIGIN updated to Vercel URL on Railway
- [ ] Can open Vercel URL and see login
- [ ] Can login with any credentials
- [ ] All 6 tabs work (Actions, Deals, Accounts, Contacts, Email, Calendar)
- [ ] No errors in browser console

**If all checked: YOU'RE DONE! 🎉**

---

## 📋 Your Deployment Info

Fill this out as you go:

```
GitHub Username:     ______________________________
GitHub Repo:         https://github.com/_________/action-crm
Railway Backend URL: https://______________________.up.railway.app
Vercel Frontend URL: https://______________________.vercel.app
JWT Secret (saved):  ______________________________
Date Deployed:       ______________________________
```

---

## 🔄 How to Make Updates Later

When you want to change code:

1. Edit files in `C:\action-crm-clean`
2. Open Command Prompt in that folder
3. Type:
   ```cmd
   git add .
   git commit -m "Description of changes"
   git push origin main
   ```
4. Railway and Vercel auto-deploy in 2-3 minutes!

---

## 🐛 Troubleshooting

### Problem: "git: command not found"
**Fix**: Restart Command Prompt (or computer)

### Problem: CORS Error in browser
**Fix**: 
- Railway → Backend → Variables → CORS_ORIGIN
- Must exactly match Vercel URL
- No trailing /

### Problem: "Network Error" when loading app
**Fix**:
- Vercel → Settings → Environment Variables
- Check REACT_APP_API_URL ends with `/api`
- Redeploy

### Problem: Backend deployment failed
**Fix**:
- Check Root Directory = `backend`
- Check Start Command = `node server.js`
- Check all environment variables are set
- Redeploy

### Problem: Frontend deployment failed
**Fix**:
- Check Root Directory = `frontend`
- Check Build Command = `npm run build`
- Check Output Directory = `build`
- Redeploy

---

## 💡 What's Next?

Now that your app is deployed:

1. **Add real features**: The current app is a demo with mock data
2. **Connect to real backend**: Update App.js to call actual API endpoints
3. **Customize branding**: Change colors, logo, company name
4. **Add authentication**: Connect to real backend auth endpoints
5. **Import data**: Add your actual deals, contacts, accounts

---

## 💰 Costs

**Current costs: $0-5/month**

- Railway: First $5 free, then $5-10/month
- Vercel: Free forever for this use case
- GitHub: Free for public repos
- Database: Included in Railway

---

## 🆘 Need Help?

**Railway Issues:**
- Status: https://railway.app/status
- Discord: https://discord.gg/railway

**Vercel Issues:**
- Status: https://vercel-status.com
- Discord: https://vercel.com/discord

**GitHub Issues:**
- Status: https://githubstatus.com

---

## 🎉 Congratulations!

You've successfully deployed a full-stack application!

**What you accomplished:**
- ✅ Set up development environment
- ✅ Created online accounts
- ✅ Deployed PostgreSQL database
- ✅ Deployed Node.js backend
- ✅ Deployed React frontend
- ✅ Connected everything together
- ✅ Got a working CRM application

**Your live app:**
- Frontend: https://action-crm-XXXX.vercel.app
- Backend: https://action-crm-XXXX.up.railway.app

Share it, use it, customize it! 🚀

---

**Need the full application with all CRUD features?** 
The current version is a demo. To add full functionality, you'll need to:
1. Complete the API integration in App.js
2. Add create/edit/delete forms
3. Connect to actual backend endpoints

This clean install gives you the foundation. Build on it! 💪
