package com.example.userservice.google;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.stereotype.Component;

@Component
public class GoogleTokenCipher {

    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;
    private final GoogleOAuthProperties properties;
    private final SecureRandom secureRandom = new SecureRandom();

    public GoogleTokenCipher(GoogleOAuthProperties properties) {
        this.properties = properties;
    }

    public EncryptedToken encrypt(String refreshToken) {
        properties.requireGrantConfigured();
        byte[] iv = new byte[IV_BYTES];
        secureRandom.nextBytes(iv);
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, iv));
            byte[] encrypted = cipher.doFinal(refreshToken.getBytes(StandardCharsets.UTF_8));
            return new EncryptedToken(
                    Base64.getEncoder().encodeToString(encrypted),
                    Base64.getEncoder().encodeToString(iv),
                    properties.getTokenEncryptionKid());
        } catch (GeneralSecurityException ex) {
            throw new IllegalStateException("Unable to encrypt Google refresh token", ex);
        }
    }

    public String decrypt(String encryptedToken, String encodedIv, String tokenKid) {
        properties.requireGrantConfigured();
        if (!properties.getTokenEncryptionKid().equals(tokenKid)) {
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_TOKEN_KEY_UNAVAILABLE);
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(
                    Cipher.DECRYPT_MODE,
                    key(),
                    new GCMParameterSpec(TAG_BITS, Base64.getDecoder().decode(encodedIv)));
            return new String(
                    cipher.doFinal(Base64.getDecoder().decode(encryptedToken)),
                    StandardCharsets.UTF_8);
        } catch (GeneralSecurityException | IllegalArgumentException ex) {
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_TOKEN_DECRYPTION_FAILED, ex);
        }
    }

    private SecretKeySpec key() {
        byte[] decoded;
        try {
            decoded = Base64.getDecoder().decode(properties.getTokenEncryptionKey());
        } catch (IllegalArgumentException ex) {
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_NOT_CONFIGURED, ex);
        }
        if (decoded.length != 32) {
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_NOT_CONFIGURED);
        }
        return new SecretKeySpec(decoded, "AES");
    }

    public record EncryptedToken(String ciphertext, String iv, String kid) {
    }
}
