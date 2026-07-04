package com.example.userservice.billing;

import com.example.userservice.billing.payos.PayosClient;
import com.example.userservice.billing.payos.PayosModels;
import com.example.userservice.entity.BillingInvoice;
import com.example.userservice.entity.BillingWebhookEvent;
import com.example.userservice.entity.UserAccount;
import com.example.userservice.repository.BillingInvoiceRepository;
import com.example.userservice.repository.BillingWebhookEventRepository;
import com.example.userservice.repository.UserAccountRepository;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.test.util.ReflectionTestUtils;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class BillingServiceTest {

  @Mock
  private PayosClient payosClient;

  @Mock
  private BillingInvoiceRepository invoiceRepository;

  @Mock
  private BillingWebhookEventRepository webhookEventRepository;

  @Mock
  private UserAccountRepository userAccountRepository;

  @InjectMocks
  private BillingService billingService;

  @BeforeEach
  void setUp() {
    ReflectionTestUtils.setField(billingService, "proPriceVnd", 79000L);
  }

  @Test
  void handlePayosWebhook_shouldMarkPaidAndUpgradeUserOnSuccess() {
    PayosModels.WebhookBody webhook = new PayosModels.WebhookBody(
        "00",
        "success",
        true,
        Map.of("orderCode", 9001L, "code", "00", "amount", 79000L),
        "sig-success-1"
    );
    when(payosClient.verifyWebhookAndExtractData(webhook)).thenReturn(webhook.data());
    when(webhookEventRepository.existsByProviderAndSignature("PAYOS", "sig-success-1"))
        .thenReturn(false);

    BillingInvoice invoice = new BillingInvoice();
    invoice.setUserId(42L);
    invoice.setOrderCode(9001L);
    invoice.setAmountVnd(79000L);
    invoice.setStatus("PENDING");
    when(invoiceRepository.findByOrderCode(9001L)).thenReturn(Optional.of(invoice));

    UserAccount user = new UserAccount();
    user.setId(42L);
    user.setPlan("FREE");
    when(userAccountRepository.findById(42L)).thenReturn(Optional.of(user));

    billingService.handlePayosWebhook(webhook);

    assertEquals("PAID", invoice.getStatus());
    assertEquals("PRO", user.getPlan());
    verify(webhookEventRepository).save(any(BillingWebhookEvent.class));
    verify(invoiceRepository).save(invoice);
    verify(userAccountRepository).save(user);
  }

  @Test
  void handlePayosWebhook_shouldSkipDuplicateSignature() {
    PayosModels.WebhookBody webhook = new PayosModels.WebhookBody(
        "00",
        "success",
        true,
        Map.of("orderCode", 9002L, "code", "00"),
        "sig-dup"
    );
    when(payosClient.verifyWebhookAndExtractData(webhook)).thenReturn(webhook.data());
    when(webhookEventRepository.existsByProviderAndSignature("PAYOS", "sig-dup"))
        .thenReturn(true);

    billingService.handlePayosWebhook(webhook);

    verify(webhookEventRepository, never()).save(any());
    verify(invoiceRepository, never()).findByOrderCode(anyLong());
    verify(userAccountRepository, never()).save(any());
  }

  @Test
  void handlePayosWebhook_validSampleUnknownOrder_acksWithoutMutatingBilling() {
    PayosModels.WebhookBody webhook = new PayosModels.WebhookBody(
        "00",
        "success",
        true,
        Map.of("orderCode", 999999L, "code", "00", "amount", 2000L, "paymentLinkId", "sample-link"),
        "sig-sample"
    );
    when(payosClient.verifyWebhookAndExtractData(webhook)).thenReturn(webhook.data());
    when(webhookEventRepository.existsByProviderAndSignature("PAYOS", "sig-sample"))
        .thenReturn(false);
    when(invoiceRepository.findByOrderCode(999999L)).thenReturn(Optional.empty());

    billingService.handlePayosWebhook(webhook);

    verify(webhookEventRepository).save(any(BillingWebhookEvent.class));
    verify(invoiceRepository, never()).save(any());
    verify(userAccountRepository, never()).save(any());
  }

  @Test
  void handlePayosWebhook_invalidSignature_propagatesWithoutMutatingBilling() {
    PayosModels.WebhookBody webhook = new PayosModels.WebhookBody(
        "00",
        "success",
        true,
        Map.of("orderCode", 9001L, "code", "00"),
        "bad-sig"
    );
    when(payosClient.verifyWebhookAndExtractData(webhook))
        .thenThrow(new IllegalArgumentException("Webhook signature invalid"));

    org.junit.jupiter.api.Assertions.assertThrows(
        IllegalArgumentException.class,
        () -> billingService.handlePayosWebhook(webhook)
    );

    verify(webhookEventRepository, never()).save(any());
    verify(invoiceRepository, never()).findByOrderCode(anyLong());
    verify(userAccountRepository, never()).save(any());
  }

  @Test
  void handlePayosWebhook_shouldNotReupgradeWhenInvoiceAlreadyPaid() {
    PayosModels.WebhookBody webhook = new PayosModels.WebhookBody(
        "00",
        "success",
        true,
        Map.of("orderCode", 9003L, "code", "00", "amount", 79000L),
        "sig-replay"
    );
    when(payosClient.verifyWebhookAndExtractData(webhook)).thenReturn(webhook.data());
    when(webhookEventRepository.existsByProviderAndSignature("PAYOS", "sig-replay"))
        .thenReturn(false);

    BillingInvoice invoice = new BillingInvoice();
    invoice.setUserId(55L);
    invoice.setOrderCode(9003L);
    invoice.setAmountVnd(79000L);
    invoice.setStatus("PAID");
    when(invoiceRepository.findByOrderCode(9003L)).thenReturn(Optional.of(invoice));

    billingService.handlePayosWebhook(webhook);

    verify(userAccountRepository, never()).findById(any());
    verify(invoiceRepository).save(invoice);
    ArgumentCaptor<BillingWebhookEvent> eventCaptor = ArgumentCaptor.forClass(BillingWebhookEvent.class);
    verify(webhookEventRepository).save(eventCaptor.capture());
    assertEquals("sig-replay", eventCaptor.getValue().getSignature());
  }

  @Test
  void handlePayosWebhook_amountMismatch_doesNotUpgrade() {
    PayosModels.WebhookBody webhook = new PayosModels.WebhookBody(
        "00",
        "success",
        true,
        Map.of("orderCode", 9005L, "code", "00", "amount", 1000L),
        "sig-amount"
    );
    when(payosClient.verifyWebhookAndExtractData(webhook)).thenReturn(webhook.data());
    when(webhookEventRepository.existsByProviderAndSignature("PAYOS", "sig-amount"))
        .thenReturn(false);

    BillingInvoice invoice = new BillingInvoice();
    invoice.setUserId(42L);
    invoice.setOrderCode(9005L);
    invoice.setAmountVnd(79000L);
    invoice.setStatus("PENDING");
    when(invoiceRepository.findByOrderCode(9005L)).thenReturn(Optional.of(invoice));

    billingService.handlePayosWebhook(webhook);

    assertEquals("PENDING", invoice.getStatus());
    verify(userAccountRepository, never()).save(any());
  }

  @Test
  void syncProPayment_shouldMarkPaidWhenPayosReportsPaid() {
    BillingInvoice invoice = new BillingInvoice();
    invoice.setUserId(42L);
    invoice.setOrderCode(9004L);
    invoice.setAmountVnd(79000L);
    invoice.setStatus("PENDING");
    when(invoiceRepository.findByOrderCode(9004L)).thenReturn(Optional.of(invoice));
    when(payosClient.getPaymentRequest(9004L))
        .thenReturn(new PayosClient.PayosPaymentInfo("PAID", 79000L, 79000L));

    UserAccount user = new UserAccount();
    user.setId(42L);
    user.setPlan("FREE");
    when(userAccountRepository.findById(42L)).thenReturn(Optional.of(user));

    BillingInvoice result = billingService.syncProPayment(42L, 9004L);

    assertEquals("PAID", result.getStatus());
    assertEquals("PRO", user.getPlan());
    verify(invoiceRepository).save(invoice);
    verify(userAccountRepository).save(user);
  }

  @Test
  void getInvoiceForUser_returnsInvoiceForOwner() {
    BillingInvoice invoice = new BillingInvoice();
    invoice.setUserId(77L);
    invoice.setOrderCode(88001L);
    invoice.setStatus("PAID");
    when(invoiceRepository.findByOrderCode(88001L)).thenReturn(Optional.of(invoice));

    BillingInvoice result = billingService.getInvoiceForUser(77L, 88001L);

    assertEquals("PAID", result.getStatus());
    assertEquals(88001L, result.getOrderCode());
  }

  @Test
  void getInvoiceForUser_rejectsOtherUsersInvoice() {
    BillingInvoice invoice = new BillingInvoice();
    invoice.setUserId(77L);
    invoice.setOrderCode(88002L);
    when(invoiceRepository.findByOrderCode(88002L)).thenReturn(Optional.of(invoice));

    org.junit.jupiter.api.Assertions.assertThrows(
        org.springframework.security.access.AccessDeniedException.class,
        () -> billingService.getInvoiceForUser(99L, 88002L)
    );
  }
}
