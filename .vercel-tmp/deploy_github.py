#!/usr/bin/env python3
"""Create GitHub repo and push jiaren-survey index.html via GitHub API."""
import requests
import base64
import json
import os
import sys

TOKEN = "ghp_k9A5JvdjbFdmSaWZIxtIXtEmKvK2f1V6ACW"
HEADERS = {
    "Authorization": f"token {TOKEN}",
    "Accept": "application/vnd.github.v3+json"
}
API = "https://api.github.com"

# The HTML file to deploy
HTML_PATH = "/Users/chenhao/Downloads/测试/jiaren-survey/index.html"
REPO_NAME = "jiaren-survey"

def check_user():
    r = requests.get(f"{API}/user", headers=HEADERS)
    if r.status_code == 200:
        user = r.json()
        print(f"✅ Logged in as: {user['login']}")
        return user['login']
    else:
        print(f"❌ Auth failed: {r.status_code} {r.text[:200]}")
        sys.exit(1)

def create_repo(owner):
    # Check if repo already exists
    r = requests.get(f"{API}/repos/{owner}/{REPO_NAME}", headers=HEADERS)
    if r.status_code == 200:
        print(f"⚠️  Repo {owner}/{REPO_NAME} already exists, will update")
        return True
    
    data = {
        "name": REPO_NAME,
        "description": "家人学习调研工具 - 四部分语音调研问卷",
        "private": False,
        "has_pages": True,
        "auto_init": False
    }
    r = requests.post(f"{API}/user/repos", headers=HEADERS, json=data)
    if r.status_code == 201:
        print(f"✅ Repo created: {owner}/{REPO_NAME}")
        return True
    else:
        print(f"❌ Failed to create repo: {r.status_code} {r.text[:200]}")
        sys.exit(1)

def upload_file(owner):
    with open(HTML_PATH, "rb") as f:
        content = f.read()
    
    content_b64 = base64.b64encode(content).decode()
    
    # Check if index.html already exists (to get its SHA)
    r = requests.get(f"{API}/repos/{owner}/{REPO_NAME}/contents/index.html", headers=HEADERS)
    
    data = {
        "message": "家人学习调研工具 v1.0",
        "content": content_b64,
        "branch": "main"
    }
    
    if r.status_code == 200:
        sha = r.json()["sha"]
        data["sha"] = sha
        data["message"] = "家人学习调研工具 - 更新"
    
    r = requests.put(f"{API}/repos/{owner}/{REPO_NAME}/contents/index.html", headers=HEADERS, json=data)
    if r.status_code in (201, 200):
        print(f"✅ index.html uploaded to {owner}/{REPO_NAME}")
        return True
    else:
        print(f"❌ Upload failed: {r.status_code} {r.text[:300]}")
        sys.exit(1)

def enable_pages(owner):
    """Enable GitHub Pages on main branch."""
    data = {
        "source": {
            "branch": "main",
            "path": "/"
        }
    }
    r = requests.post(f"{API}/repos/{owner}/{REPO_NAME}/pages", headers=HEADERS, json=data)
    if r.status_code in (201, 204):
        print(f"✅ GitHub Pages enabled")
        return True
    else:
        print(f"⚠️  Pages setup: {r.status_code} {r.text[:200]}")
        return False

def main():
    print("=== GitHub Pages Deploy ===")
    owner = check_user()
    create_repo(owner)
    upload_file(owner)
    enable_pages(owner)
    
    url = f"https://{owner}.github.io/{REPO_NAME}/"
    print(f"\n✅ Deployed! Visit: {url}")
    print(f"   (May take 1-2 minutes for GitHub Pages to build)")
    print(json.dumps({"status": "success", "url": url}))

if __name__ == "__main__":
    main()
