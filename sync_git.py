import os
import subprocess
from datetime import datetime

def check_internet():
    # On essaie de contacter le DNS de Google (8.8.8.8) très rapidement
    try:
        subprocess.run(["ping", "-c", "1", "-W", "2", "8.8.8.8"], capture_output=True, check=True)
        return True
    except:
        return False

def run_cmd(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True)

def sync():
    # 1. Enregistrement local (marche toujours)
    status = run_cmd("git status --porcelain")
    if status.stdout.strip():
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        run_cmd("git add .")
        run_cmd(f'git commit -m "Auto-sync: {now}"')
        print(f"💾 Sauvegarde locale effectuée à {now}.")
    else:
        print("✨ Aucun nouveau changement local.")

    # 2. Vérification Internet avant le Push
    print("🔍 Vérification de la connexion...")
    if check_internet():
        print("🌐 Internet OK. Envoi vers GitHub...")
        # On s'assure que Git se souvienne de la clé après le premier succès
        run_cmd("git config --global credential.helper store")
        
        push = subprocess.run("git push origin main", shell=True) # On laisse l'output normal pour voir le prompt
        if push.returncode == 0:
            print("✅ Synchronisation en ligne terminée !")
        else:
            print("❌ Le push a échoué (vérifie tes accès ou le blocage de secret).")
    else:
        print("📴 Tu es hors-ligne. Les changements restent sur ton PC pour l'instant.")
        print("🚀 Relance le script quand tu auras retrouvé la connexion.")

if __name__ == "__main__":
    sync()
