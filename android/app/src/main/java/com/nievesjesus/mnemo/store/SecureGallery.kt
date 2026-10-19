package com.nievesjesus.mnemo.store

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.nievesjesus.mnemo.pipeline.dot
import com.nievesjesus.mnemo.pipeline.l2normalize
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

data class Consent(val identification: Boolean = true, val notes: Boolean = false, val encounterLog: Boolean = false)

data class Identity(
    val id: String,
    val name: String,
    val relation: String,
    val phrase: String,
    val context: String,
    val consent: Consent,
    val template: FloatArray,
    val validShots: Int,
    val enrolledAt: Long,
    val expiresAt: Long,
) {
  val isWeak get() = validShots < 3
  val isExpired get() = System.currentTimeMillis() >= expiresAt
}

/**
 * Closed, encrypted gallery.
 *
 * Non-exportable AES-256-GCM key in the Android Keystore (backed by TEE/StrongBox when available).
 * Each identity is an encrypted blob with the id as associated data. An image is never stored.
 * Exhaustive 1:N search over N ≤ 50.
 */
class SecureGallery(ctx: Context, private val maxSize: Int = 50) {
  private val db = Helper(ctx).writableDatabase
  private val cache = LinkedHashMap<String, Identity>()

  init {
    db.rawQuery("SELECT id, iv, blob FROM identities", null).use { c ->
      while (c.moveToNext()) cache[c.getString(0)] = decode(c.getString(0), c.getBlob(1), c.getBlob(2))
    }
  }

  fun all(): List<Identity> = cache.values.toList()

  fun active(): List<Identity> = cache.values.filter { !it.isExpired && it.consent.identification }

  fun get(id: String) = cache[id]

  fun search(q: FloatArray): Pair<Identity?, Float> {
    var best: Identity? = null
    var s = -1f
    for (i in active()) {
      val v = dot(q, i.template)
      if (v > s) { s = v; best = i }
    }
    return best to s
  }

  /** Only invoked by the enrollment flow, after the person has given consent. */
  fun enroll(name: String, relation: String, template: FloatArray, consent: Consent, validShots: Int, phrase: String? = null, context: String = ""): Identity {
    require(consent.identification) { "No template is created without identification consent" }
    check(cache.size < maxSize) { "The gallery holds at most $maxSize identities" }
    val now = System.currentTimeMillis()
    val ident = Identity(
        UUID.randomUUID().toString(), name, relation, phrase ?: "Es $name, $relation.",
        if (consent.notes) context else "", consent, l2normalize(template), validShots, now, now + 365L * 24 * 3600 * 1000)
    val (iv, blob) = encode(ident)
    db.insertOrThrow("identities", null, ContentValues().apply { put("id", ident.id); put("iv", iv); put("blob", blob) })
    audit("alta", ident.id, "tomas=$validShots")
    cache[ident.id] = ident
    return ident
  }

  /** Immediate, irreversible deletion; only the record of the operation remains. */
  fun revoke(id: String, by: String = "titular") {
    db.delete("identities", "id = ?", arrayOf(id))
    audit("revocacion", id, by)
    cache.remove(id)
    db.execSQL("VACUUM")
  }

  private fun audit(op: String, ref: String, detail: String) {
    db.insert("audit", null, ContentValues().apply {
      put("ts", System.currentTimeMillis()); put("op", op); put("ref", ref); put("detail", detail)
    })
  }

  // --- encryption ---------------------------------------------------------------
  private fun key(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
          .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
          .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
          .setKeySize(256)
          .build())
    }.generateKey()
  }

  private fun encode(i: Identity): Pair<ByteArray, ByteArray> {
    val tpl = ByteBuffer.allocate(i.template.size * 4).order(ByteOrder.LITTLE_ENDIAN).apply { i.template.forEach { putFloat(it) } }.array()
    val json = JSONObject().apply {
      put("name", i.name); put("relation", i.relation); put("phrase", i.phrase); put("context", i.context)
      put("cId", i.consent.identification); put("cNotes", i.consent.notes); put("cLog", i.consent.encounterLog)
      put("shots", i.validShots); put("enrolledAt", i.enrolledAt); put("expiresAt", i.expiresAt)
      put("template", android.util.Base64.encodeToString(tpl, android.util.Base64.NO_WRAP))
    }
    val cipher = Cipher.getInstance(TRANSFORM).apply { init(Cipher.ENCRYPT_MODE, key()); updateAAD(i.id.toByteArray()) }
    return cipher.iv to cipher.doFinal(json.toString().toByteArray())
  }

  private fun decode(id: String, iv: ByteArray, blob: ByteArray): Identity {
    val cipher = Cipher.getInstance(TRANSFORM).apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv)); updateAAD(id.toByteArray()) }
    val j = JSONObject(String(cipher.doFinal(blob)))
    val tpl = ByteBuffer.wrap(android.util.Base64.decode(j.getString("template"), android.util.Base64.NO_WRAP)).order(ByteOrder.LITTLE_ENDIAN)
    return Identity(
        id, j.getString("name"), j.getString("relation"), j.getString("phrase"), j.getString("context"),
        Consent(j.getBoolean("cId"), j.getBoolean("cNotes"), j.getBoolean("cLog")),
        FloatArray(512) { tpl.getFloat() }, j.getInt("shots"), j.getLong("enrolledAt"), j.getLong("expiresAt"))
  }

  private class Helper(ctx: Context) : SQLiteOpenHelper(ctx, "gallery.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
      db.execSQL("CREATE TABLE identities (id TEXT PRIMARY KEY, iv BLOB NOT NULL, blob BLOB NOT NULL)")
      db.execSQL("CREATE TABLE audit (ts INTEGER, op TEXT, ref TEXT, detail TEXT)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
  }

  private companion object {
    const val KEY_ALIAS = "mnemo-gallery"
    const val TRANSFORM = "AES/GCM/NoPadding"
  }
}
