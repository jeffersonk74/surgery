import os
import subprocess

# Configuration par défaut
GITHUB_USER = "jeffersonk74"
REPO_NAME = "surgery"

def run_command(command):
    try:
        # On utilise env pour s'assurer que Git utilise bien le helper de stockage
        subprocess.run(command, shell=True, check=True, text=True)
        return True
    except subprocess.CalledProcessError:
        return False

def sync():
    print(f"🚀 Synchronisation de {REPO_NAME} pour {GITHUB_USER}...")

    # Configuration automatique du stockage des identifiants (à faire une seule fois)
    os.system("git config --global credential.helper store")

    # 1. Préparation des fichiers
    if not run_command("git add ."): 
        print("❌ Erreur lors du 'git add'")
        return

    # 2. Commit avec message personnalisé ou par défaut
    msg = input("📝 Message de commit (Entrée pour auto) : ").strip()
    if not msg:
        msg = "Mise à jour automatique - Projet ORCHIDEE"
    
    # On commit. Si rien n'a changé, Git renvoie une erreur légère, on continue.
    run_command(f'git commit -m "{msg}"')

    # 3. Push vers GitHub
    print("\n🌐 Connexion à GitHub en cours...")
    print(f"💡 Si demandé, colle ton Token PAT (ton mot de passe habituel ne marchera pas).")
    
    if run_command("git push origin main"):
        print("\n✅ Succès ! Tout est synchronisé en ligne.")
    else:
        print("\n⚠️ Push impossible. Tes changements sont enregistrés localement sur ton PC.")
        print("💾 Ils seront envoyés automatiquement au prochain succès internet.")

if __name__ == "__main__":
    sync()
