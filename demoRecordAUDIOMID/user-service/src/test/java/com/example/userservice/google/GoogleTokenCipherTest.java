package com.example.userservice.google;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.Base64;
import org.junit.jupiter.api.Test;

class GoogleTokenCipherTest {

    @Test
    void encryptDecryptRoundTripDoesNotStorePlaintext() {
        GoogleOAuthProperties properties = configuredProperties((byte) 7, "v1");
        GoogleTokenCipher cipher = new GoogleTokenCipher(properties);

        GoogleTokenCipher.EncryptedToken encrypted = cipher.encrypt("refresh-token-value");

        assertThat(encrypted.ciphertext()).doesNotContain("refresh-token-value");
        assertThat(cipher.decrypt(encrypted.ciphertext(), encrypted.iv(), encrypted.kid()))
                .isEqualTo("refresh-token-value");
    }

    @Test
    void decryptRejectsUnknownKeyId() {
        GoogleOAuthProperties properties = configuredProperties((byte) 3, "v2");
        GoogleTokenCipher cipher = new GoogleTokenCipher(properties);
        GoogleTokenCipher.EncryptedToken encrypted = cipher.encrypt("secret");

        assertThatThrownBy(() -> cipher.decrypt(encrypted.ciphertext(), encrypted.iv(), "v1"))
                .isInstanceOf(GoogleOAuthException.class)
                .extracting(error -> ((GoogleOAuthException) error).error())
                .isEqualTo(GoogleOAuthError.GOOGLE_TOKEN_KEY_UNAVAILABLE);
    }

    private GoogleOAuthProperties configuredProperties(byte fill, String kid) {
        byte[] key = new byte[32];
        java.util.Arrays.fill(key, fill);
        GoogleOAuthProperties properties = new GoogleOAuthProperties();
        properties.setEnabled(true);
        properties.setClientId("client");
        properties.setClientSecret("secret");
        properties.setRedirectUri("http://localhost/callback");
        properties.setFrontendBaseUrl("http://localhost");
        properties.setLinkRedirectUri("http://localhost/link/callback");
        properties.setTokenEncryptionKey(Base64.getEncoder().encodeToString(key));
        properties.setTokenEncryptionKid(kid);
        properties.setInternalServiceToken("internal-secret");
        return properties;
    }
}
