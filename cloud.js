// Shared books: Firebase sign-in + Firestore.
// Every signed-in person has one book at books/{uid}; everyone signed in can read every book,
// only the owner can write to theirs (see firestore.rules).
const V = "11.10.0";
const base = `https://www.gstatic.com/firebasejs/${V}/`;

export async function initCloud(config, useEmulator) {
  const { initializeApp } = await import(base + "firebase-app.js");
  const A = await import(base + "firebase-auth.js");
  const F = await import(base + "firebase-firestore.js");

  const app = initializeApp(config);
  const auth = A.getAuth(app);
  let db;
  try { db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) }); }
  catch (e) { db = F.getFirestore(app); }
  if (useEmulator) {
    A.connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    F.connectFirestoreEmulator(db, "127.0.0.1", 8080);
  }

  const bookRef = uid => F.doc(db, "books", uid);
  const recipesCol = uid => F.collection(db, "books", uid, "recipes");
  const photosCol = uid => F.collection(db, "books", uid, "photos");
  const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

  return {
    onUser(fn) { return A.onAuthStateChanged(auth, fn); },
    user() { return auth.currentUser; },

    async signIn(email, password) { await A.signInWithEmailAndPassword(auth, email, password); },
    async signUp(name, email, password) {
      const cred = await A.createUserWithEmailAndPassword(auth, email, password);
      await A.updateProfile(cred.user, { displayName: name });
      return cred.user;
    },
    async resetPassword(email) { await A.sendPasswordResetEmail(auth, email); },
    async signOut() { await A.signOut(auth); },

    async getBook(uid) {
      const s = await F.getDoc(bookRef(uid));
      return s.exists() ? { id: s.id, ...s.data() } : null;
    },
    async createBook(uid, data) {
      await F.setDoc(bookRef(uid), { ...data, recipeCount: 0, createdAt: F.serverTimestamp(), updatedAt: F.serverTimestamp() });
    },
    async updateBook(uid, data) {
      await F.updateDoc(bookRef(uid), { ...data, updatedAt: F.serverTimestamp() });
    },
    async listBooks() {
      const s = await F.getDocs(F.collection(db, "books"));
      return s.docs.map(d => ({ id: d.id, ...d.data() }));
    },

    async listRecipes(uid) {
      const s = await F.getDocs(recipesCol(uid));
      return s.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    // returns the recipe id
    async saveRecipe(uid, recipe) {
      const { id, ...data } = recipe;
      const body = clean({ ...data, updatedAt: F.serverTimestamp() });
      if (id) { await F.setDoc(F.doc(recipesCol(uid), id), body); return id; }
      const ref = await F.addDoc(recipesCol(uid), { ...body, createdAt: F.serverTimestamp() });
      return ref.id;
    },
    async deleteRecipe(uid, id) {
      const b = F.writeBatch(db);
      b.delete(F.doc(recipesCol(uid), id));
      b.delete(F.doc(photosCol(uid), id));
      await b.commit();
    },
    // many recipes in one go (used for the one-time import)
    async importRecipes(uid, list) {
      for (let i = 0; i < list.length; i += 400) {
        const b = F.writeBatch(db);
        list.slice(i, i + 400).forEach(r => {
          const { id, ...data } = r;
          b.set(F.doc(recipesCol(uid), id), clean({ ...data, createdAt: F.serverTimestamp(), updatedAt: F.serverTimestamp() }));
        });
        await b.commit();
      }
    },

    async loadPhotos(uid) {
      const s = await F.getDocs(photosCol(uid));
      const out = {};
      s.docs.forEach(d => { const v = d.data().data; if (typeof v === "string" && v.startsWith("data:image/")) out[d.id] = v; });
      return out;
    },
    async savePhoto(uid, id, dataUrl) { await F.setDoc(F.doc(photosCol(uid), id), { data: dataUrl, updatedAt: F.serverTimestamp() }); },
    async removePhoto(uid, id) { await F.deleteDoc(F.doc(photosCol(uid), id)); }
  };
}
